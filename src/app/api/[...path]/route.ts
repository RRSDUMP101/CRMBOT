import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { database, demoMode, transaction } from '@/lib/db';
import { ApiError, STAFF_COOKIE, assertOrigin, checkPassword, cookieValue, fields, hashToken, isWidgetRequest, newToken, rateLimit, readJson, setCookie, staffSession, str, uuid, visitorCookieName, visitorSession } from '@/lib/auth';
import { adminAction, appointmentConfirm, appointmentPreview, conversationAction, conversationDetail, createVisitor, handoff, messageStream, publicMember, saveContact, snapshot, visitorDetail } from '@/lib/service';
import { providerName } from '@/lib/bot';
import { adminWidgetConfig, getPublicWidgetConfig, getWidgetEmbedConfig, inbox, inboxSummary, markConversationRead, replyTemplates, saveWidgetConfig, templateAction } from '@/lib/helpdesk';
import {downloadFile,listFiles,uploadFile} from '@/lib/files';
import {realtimeResponse} from '@/lib/realtime';
import {downloadSocialAttachment} from '@/lib/social-media';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;

function json(body:unknown,status=200,headers:Record<string,string>={}) {
  return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
}
async function handle(request:NextRequest) {
  const url=new URL(request.url);const path=url.pathname.replace(/^\/api\//,'').split('/').filter(Boolean);
  const method=request.method;
  try {
    if(method==='POST')assertOrigin(request);
    if(path.join('/')==='widget/config'&&method==='GET') {
      const origin=request.headers.get('origin')||undefined;
      const config=await getPublicWidgetConfig(origin);
      return json({config},200,origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{'Vary':'Origin'});
    }
    if(path.join('/')==='bootstrap'&&method==='GET') {
      const user=await staffSession(request,false);return json({demo:demoMode(),provider:providerName(),user:user?publicMember(user):null});
    }
    if(path.join('/')==='auth/login'&&method==='POST') {
      const body=await readJson(request);fields(body,['email','username','password']);
      if(body.email!==undefined&&body.username!==undefined)throw new ApiError(400,'ระบุชื่อผู้ใช้หรืออีเมลเพียงรายการเดียว');
      const login=str(body.username??body.email,'ชื่อผู้ใช้หรืออีเมล',254,true).toLowerCase();const password=str(body.password,'รหัสผ่าน',200,true);
      // Trust a real client IP only when a controlled reverse proxy supplies this configured header.
      const ipHeader=process.env.TRUSTED_IP_HEADER;const address=ipHeader?request.headers.get(ipHeader)||'unknown':'single-host';
      await rateLimit(`login-ip:${address}`,60,900);
      const member=(await database.query('SELECT * FROM members WHERE email=$1 OR username=$1',[login])).rows[0];
      // Username and email aliases share a single account bucket.
      await rateLimit(`login-account:${member?.id||login}`,10,900);
      const dummy='pbkdf2:600000:'+ '0'.repeat(32)+':'+ '0'.repeat(64);
      const valid=await checkPassword(password,member?.password_hash||dummy);
      if(!member||!valid||member.active!==true)throw new ApiError(401,'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      const token=newToken();
      const current=await transaction(member.org_id,async connection=>{
        const fresh=(await connection.query('SELECT id,name,email,role,active,password_hash FROM members WHERE org_id=$1 AND id=$2',[member.org_id,member.id])).rows[0];
        if(!fresh?.active||fresh.password_hash!==member.password_hash)throw new ApiError(401,'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
        await connection.query("INSERT INTO staff_sessions(token_hash,org_id,member_id,expires_at) VALUES($1,$2,$3,(strftime('%Y-%m-%dT%H:%M:%f','now','+12 hours')||'000Z'))",[hashToken(token),member.org_id,member.id]);
        return {id:fresh.id,name:fresh.name,email:fresh.email,role:fresh.role};
      });
      return json({user:current},200,{'Set-Cookie':setCookie(STAFF_COOKIE,token,43200)});
    }
    if(path.join('/')==='auth/logout'&&method==='POST') {
      const token=cookieValue(request,STAFF_COOKIE);if(token)await database.query('DELETE FROM staff_sessions WHERE token_hash=$1',[hashToken(token)]);
      return json({ok:true},200,{'Set-Cookie':setCookie(STAFF_COOKIE,'',0)});
    }
    if(path[0]==='admin') {
      const staff=(await staffSession(request))!;
      if(path.join('/')==='admin/events'&&method==='GET')return await realtimeResponse(request,'staff');
      if(path[1]==='social-attachments'&&path.length===3&&method==='GET')return await downloadSocialAttachment(staff.orgId,uuid(path[2]),fetch,staff.role==='Admin');
      if(method==='POST')await rateLimit(`staff:${staff.orgId}:${staff.id}`,120,60);
      if(path.join('/')==='admin/media-archive'&&method==='GET')return json(await (await import('@/lib/media-archive-queue')).mediaArchiveStatus(staff));
      if(path.join('/')==='admin/media-archive/retry'&&method==='POST'){
        const body=await readJson(request);fields(body,['attachmentId']);return json(await (await import('@/lib/media-archive-queue')).retryMediaArchive(staff,uuid(body.attachmentId)));
      }
      if(path[1]==='leads'&&path.length===4&&path[3]==='files') {
        if(method==='GET')return json(await listFiles(staff,uuid(path[2])));
        if(method==='POST'){await rateLimit(`upload:${staff.orgId}:${staff.id}`,20,3600);return json(await uploadFile(staff,uuid(path[2]),request),201);}
      }
      if(path[1]==='files'&&path.length===3&&method==='GET')return await downloadFile(staff,uuid(path[2]));
      if(path.join('/')==='admin/widget'&&method==='GET')return json(await adminWidgetConfig(staff));
      if(path.join('/')==='admin/widget'&&method==='POST')return json(await saveWidgetConfig(staff,await readJson(request)));
      if(path.join('/')==='admin/inbox'&&method==='GET')return json(await inbox(staff,url));
      if(path.join('/')==='admin/inbox/summary'&&method==='GET')return json(await inboxSummary(staff));
      if(path.join('/')==='admin/reply-templates'&&method==='GET')return json(await replyTemplates(staff));
      if(path[1]==='snapshot'&&path.length===2&&method==='GET')return json(await snapshot(staff,url));
      if(path[1]==='conversations'&&path.length===3&&method==='GET')return json(await conversationDetail(staff.orgId,uuid(path[2]),true,staff.role==='Admin'));
      if(path[1]==='conversations'&&path.length===4&&path[3]==='read'&&method==='POST')return json(await markConversationRead(staff,uuid(path[2]),await readJson(request)));
      if(path[1]==='conversations'&&path.length===4&&method==='POST')return json(await conversationAction(staff,uuid(path[2]),path[3],await readJson(request)));
      if(path[1]==='action'&&path.length===2&&method==='POST') {
        const body=await readJson(request);
        return json(await (['saveReplyTemplate','deleteReplyTemplate'].includes(String(body.action))?templateAction(staff,body):adminAction(staff,body)));
      }
    }
    if(path[0]==='chat') {
      const widget=isWidgetRequest(request);
      if(widget&&!(await getWidgetEmbedConfig()).enabled)throw new ApiError(403,'วิดเจ็ตแชตปิดใช้งานอยู่');
      if(path[1]==='session'&&path.length===2&&method==='POST') {
        fields(await readJson(request),[]);const existing=await visitorSession(request,false);
        if(existing)return json(await visitorDetail(existing));
        const ipHeader=process.env.TRUSTED_IP_HEADER;const address=ipHeader?request.headers.get(ipHeader)||'unknown':'single-host';
        await rateLimit(`visitor-create:${address}`,demoMode()?200:40,3600);
        const created=await createVisitor(widget?'widget':'web');return json(await visitorDetail(created.visitor),201,{'Set-Cookie':setCookie(visitorCookieName(request),created.token,30*86400)});
      }
      const visitor=(await visitorSession(request))!;
      if(path.join('/')==='chat/events'&&method==='GET')return await realtimeResponse(request,'visitor');
      if(path.length===1&&method==='GET')return json(await visitorDetail(visitor));
      if(method==='POST') {
        const body=await readJson(request);
        if(path[1]==='message'&&path.length===2)return await messageStream(visitor,body,request.signal);
        await rateLimit(`visitor-action:${visitor.orgId}:${visitor.conversationId}`,60,60);
        if(path[1]==='handoff'&&path.length===2){fields(body,[]);await handoff(visitor);return json({ok:true});}
        if(path[1]==='contact'&&path.length===2)return json(await saveContact(visitor,body));
        if(path[1]==='appointment'&&path[2]==='preview'&&path.length===3)return json(await appointmentPreview(visitor,body));
        if(path[1]==='appointment'&&path[2]==='confirm'&&path.length===3)return json(await appointmentConfirm(visitor,body));
      }
    }
    return json({error:'ไม่พบ API ที่ร้องขอ'},404);
  } catch(error) {
    if(error instanceof ApiError)return json({error:error.message},error.status);
    const incident=randomUUID();const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:undefined;
    console.error('[rrs] request_failed',{incident,route:path.slice(0,2).join('/'),type:error instanceof Error?error.name:'Unknown',code});
    return json({error:`ระบบไม่สามารถทำรายการได้ กรุณาลองใหม่ (รหัส ${incident.slice(0,8)})`},500);
  }
}
export const GET=handle;
export const POST=handle;
