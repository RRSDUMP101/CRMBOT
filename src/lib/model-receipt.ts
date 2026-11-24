import type {Executor} from './db';
import type {ModelIdentity} from './model-identity';

/** The matching message and its staff-only receipt commit in the same transaction. */
export async function recordModelReceipt(db:Executor,orgId:string,messageId:string,identity:ModelIdentity) {
  await db.query("INSERT INTO audit_events(id,org_id,actor_id,action,entity_id,metadata) VALUES($1,$2,'system','ai.model.used',$1,$3)",[messageId,orgId,JSON.stringify(identity)]);
}
