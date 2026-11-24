import {database,type Executor} from './db';
import {requireAdmin,uuid,type Staff} from './auth';

type Key='botName'|'replyTemplate';
export async function rememberSetting(connection:Executor,staff:Staff,kind:Key,id:string,value:unknown) {
  await connection.query(`INSERT INTO sales_setting_undo(org_id,kind,entity_id,previous_value) VALUES($1,$2,$3,$4)
    ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET previous_value=excluded.previous_value`,[staff.orgId,kind,id,JSON.stringify(value)]);
}
export async function previousSalesSetting(staff:Staff,templateId:string|null) {
  requireAdmin(staff);
  const id=templateId===null?staff.orgId:uuid(templateId);
  const result=await database.query('SELECT previous_value FROM sales_setting_undo WHERE org_id=$1 AND kind=$2 AND entity_id=$3',[staff.orgId,templateId===null?'botName':'replyTemplate',id]);
  return {previous:result.rows.length?JSON.parse(result.rows[0].previous_value):null};
}
