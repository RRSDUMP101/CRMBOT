import {database,withDatabase,type D1Binding} from './db';
/** Unique insert is the replay fence; each retry must sign a fresh nonce. */
export function bridgeNonceClaimer(orgId:string,binding?:D1Binding){return async(keyId:string,nonce:string,expiresAt:number)=>{
  const claim=async()=>{
    await database.query('DELETE FROM crm_bridge_nonces WHERE org_id=$1 AND expires_at<$2',[orgId,Date.now()]);
    const result=await database.query('INSERT OR IGNORE INTO crm_bridge_nonces(org_id,key_id,nonce,expires_at) VALUES($1,$2,$3,$4)',[orgId,keyId,nonce,expiresAt]);
    return result.rowCount===1;
  };
  return binding?withDatabase(binding,claim):claim();
};}
