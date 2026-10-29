import {randomUUID} from 'node:crypto';
import {database,transaction,type Executor,type Row} from './db';
import {ApiError,type Staff,uuid} from './auth';
import {archiveSocialAttachment} from './social-media';
import {readSocialConfig,type SocialChannelConfig} from './social-channels';

const active=['queued','working','retry','blocked'];
const limitAttempts=8,leaseMs=90_000;
const metadata=(row:Row)=>typeof row.metadata==='string'?JSON.parse(row.metadata):row.metadata||{};
export async function enqueueInboundMediaArchive(c:Executor,config:SocialChannelConfig,attachmentId:string){
  if(config.provider!=='whatsapp')return;
  const time=new Date().toISOString();
  await c.query("INSERT OR IGNORE INTO social_media_archive_jobs(org_id,attachment_id,account_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4)",[config.orgId,attachmentId,config.accountId,time]);
}
async function attachment(c:Executor,orgId:string,id:string){return (await c.query('SELECT a.*,p.direction,p.removed_at AS parent_removed_at,m.role,m.source_owner_only FROM social_message_attachments a JOIN social_message_provenance p ON p.org_id=a.org_id AND p.message_id=a.message_id JOIN messages m ON m.org_id=a.org_id AND m.id=a.message_id WHERE a.org_id=$1 AND a.id=$2',[orgId,id])).rows[0];}
function native(row:Row|undefined){const m=row?metadata(row):{};return !!row&&row.provider==='whatsapp'&&row.direction==='in'&&row.role==='user'&&!row.source_owner_only&&!m.sourceSystem&&!m.reviewedSale&&!m.sourceOwnerOnly&&!m.sourceScopeUnknown&&!row.removed_at&&!row.parent_removed_at&&row.storage_state!=='removed';}
function current(config:SocialChannelConfig,orgId:string,accountId:string){return process.env.SOCIAL_MEDIA_ARCHIVE_ENABLED==='true'&&config.owner==='crm'&&config.inboundEnabled&&config.orgId===orgId&&config.accountId===accountId&&!!config.accessToken;}
async function publish(c:Executor,orgId:string,id:string,state:string,error:string,next:number){
  const row=(await c.query('SELECT metadata,removed_at FROM social_message_attachments WHERE org_id=$1 AND id=$2',[orgId,id])).rows[0];
  if(row&&!row.removed_at)await c.query('UPDATE social_message_attachments SET metadata=$3 WHERE org_id=$1 AND id=$2',[orgId,id,JSON.stringify({...metadata(row),archiveState:state,archiveError:error,archiveNextAttemptAt:next})]);
}
type Options={fetch?:typeof fetch;now?:()=>number;readConfig?:()=>SocialChannelConfig};
/** Bounded GET-only archival. Claimed jobs survive restarts and never send messages. */
export async function runMediaArchiveJobs(orgId:string,limit=4,options:Options={}){
  uuid(orgId);const clock=options.now||Date.now,config=options.readConfig||(()=>readSocialConfig('whatsapp'));
  if(process.env.SOCIAL_MEDIA_ARCHIVE_ENABLED!=='true')return {results:[] as {attachmentId:string;status:string}[],disabled:true};
  const size=Math.min(4,Math.max(1,Math.floor(Number.isFinite(limit)?limit:4))),now=clock();
  const candidates=(await database.query("SELECT attachment_id FROM social_media_archive_jobs WHERE org_id=$1 AND status IN ('queued','working','retry','blocked') AND next_attempt_at<=$2 AND lease_until<=$2 ORDER BY next_attempt_at,created_at,attachment_id LIMIT $3",[orgId,now,size])).rows;
  const results:{attachmentId:string;status:string}[]=[];
  for(const candidate of candidates){
    const id=String(candidate.attachment_id),token=randomUUID();
    const claim=await transaction(orgId,async c=>{
      const job=(await c.query('SELECT * FROM social_media_archive_jobs WHERE org_id=$1 AND attachment_id=$2',[orgId,id])).rows[0];
      if(!job||!active.includes(job.status)||job.lease_until>clock()||job.next_attempt_at>clock())return null;
      const row=await attachment(c,orgId,id),cfg=config();
      const stop=!native(row)?'cancelled':!current(cfg,orgId,job.account_id)||row.account_id!==job.account_id?'blocked':Number(job.attempts)>=limitAttempts?'failed':null;
      if(stop){const error=stop==='cancelled'?'attachment_removed_or_not_native':stop==='blocked'?'ownership_or_account_unavailable':'attempt_limit';const next=stop==='blocked'?clock()+60_000:0;await c.query('UPDATE social_media_archive_jobs SET status=$3,error_code=$4,next_attempt_at=$5,lease_until=0,lease_token=\'\',updated_at=$6 WHERE org_id=$1 AND attachment_id=$2',[orgId,id,stop,error,next,new Date(clock()).toISOString()]);await publish(c,orgId,id,stop,error,next);return {stop};}
      const attempts=Number(job.attempts)+1;
      await c.query("UPDATE social_media_archive_jobs SET status='working',attempts=$3,lease_until=$4,lease_token=$5,error_code='',updated_at=$6 WHERE org_id=$1 AND attachment_id=$2",[orgId,id,attempts,clock()+leaseMs,token,new Date(clock()).toISOString()]);
      await publish(c,orgId,id,'working','',0);return {attempts,accountId:String(job.account_id)};
    });
    if(!claim)continue;if('stop' in claim){results.push({attachmentId:id,status:claim.stop!});continue;}
    const guard=async()=>{
      const job=(await database.query('SELECT * FROM social_media_archive_jobs WHERE org_id=$1 AND attachment_id=$2',[orgId,id])).rows[0],row=await attachment(database,orgId,id);
      if(!native(row))throw new ApiError(404,'Attachment unavailable');
      if(!job||job.lease_token!==token||job.status!=='working'||job.lease_until<=clock()||!current(config(),orgId,claim.accountId!)||row.account_id!==claim.accountId)throw new ApiError(409,'Archival ownership changed');
    };
    let status='archived',error='',next=0;
    try{await guard();await archiveSocialAttachment(orgId,id,options.fetch||fetch,false,guard);}
    catch(reason){
      const code=reason instanceof ApiError?reason.status:503;
      status=code===404?'cancelled':code===413||code===415?'failed':claim.attempts!>=limitAttempts?'failed':'retry';
      error=code===413?'media_size_limit':code===415?'media_integrity_failed':code===404?'attachment_removed':code===409?'ownership_quota_or_content_conflict':code===403?'attachment_permission_changed':'provider_or_storage_unavailable';
      if(status==='retry')next=clock()+Math.min(3_600_000,15_000*2**Math.min(claim.attempts!-1,8));
    }
    await transaction(orgId,async c=>{
      const job=(await c.query('SELECT lease_token,status FROM social_media_archive_jobs WHERE org_id=$1 AND attachment_id=$2',[orgId,id])).rows[0];if(job?.lease_token!==token||job.status!=='working')return;
      if(!native(await attachment(c,orgId,id))){status='cancelled';error='attachment_removed_or_not_native';next=0;}
      await c.query("UPDATE social_media_archive_jobs SET status=$3,error_code=$4,next_attempt_at=$5,lease_until=0,lease_token='',updated_at=$6 WHERE org_id=$1 AND attachment_id=$2",[orgId,id,status,error,next,new Date(clock()).toISOString()]);await publish(c,orgId,id,status,error,next);
    });results.push({attachmentId:id,status});
  }
  return {results,disabled:false};
}
export async function mediaArchiveStatus(staff:Staff){
  if(staff.role!=='Admin')throw new ApiError(403,'Administrator required');
  const actor=(await database.query('SELECT role,active FROM members WHERE org_id=$1 AND id=$2',[staff.orgId,staff.id])).rows[0];if(!actor?.active||actor.role!=='Admin')throw new ApiError(403,'Administrator required');
  return {jobs:(await database.query('SELECT attachment_id,status,attempts,next_attempt_at,error_code,updated_at FROM social_media_archive_jobs WHERE org_id=$1 ORDER BY updated_at DESC LIMIT 100',[staff.orgId])).rows};
}
export async function retryMediaArchive(staff:Staff,id:string){
  if(staff.role!=='Admin')throw new ApiError(403,'Administrator required');uuid(id);
  await transaction(staff.orgId,async c=>{
    const job=(await c.query('SELECT * FROM social_media_archive_jobs WHERE org_id=$1 AND attachment_id=$2',[staff.orgId,id])).rows[0];
    if(!job||!native(await attachment(c,staff.orgId,id)))throw new ApiError(404,'Native attachment unavailable');
    if(!current(readSocialConfig('whatsapp'),staff.orgId,job.account_id))throw new ApiError(409,'Archival ownership unavailable');
    if(!['failed','retry','blocked'].includes(job.status))throw new ApiError(409,'Archive job is not retryable');
    await c.query("UPDATE social_media_archive_jobs SET status='queued',attempts=0,next_attempt_at=0,lease_until=0,lease_token='',error_code='',updated_at=$3 WHERE org_id=$1 AND attachment_id=$2",[staff.orgId,id,new Date().toISOString()]);await publish(c,staff.orgId,id,'queued','',0);
  },staff);return {ok:true};
}
