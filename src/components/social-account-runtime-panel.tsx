"use client";
import { useEffect, useState } from 'react';
import { api, date } from './data';
import { Button, Field, Input } from './ui';

export function SocialAccountRuntimePanel({ account, refresh }: { account: { id: string; revision: number; state: string; runtime?: { available: boolean; inboundEnabled: boolean; liveEnabled: boolean; testRecipient: string } }; refresh: () => Promise<unknown> }) {
  const [inbound, setInbound] = useState(false), [live, setLive] = useState(false), [recipient, setRecipient] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [status, setStatus] = useState<Record<string, any> | null>(null);
  useEffect(() => { setInbound(!!account.runtime?.inboundEnabled); setLive(!!account.runtime?.liveEnabled); setRecipient(account.runtime?.testRecipient || ''); }, [account.id, account.revision]);
  if (!account.runtime?.available) return null;
  const path = '/api/admin/social-accounts/' + account.id + '/runtime';
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); setConfirm(false); setNotice(message); try { setStatus(await api(path)); } catch { setStatus(null); } }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="form-stack rrs-account-runtime" aria-label="การรับและส่งของบัญชีนี้">
    <h3>การรับและส่งของบัญชีนี้</h3><p className="helper-text">เปิดรับข้อความก่อน ทดสอบกับผู้รับที่กำหนด แล้วตรวจผลส่งก่อนเปิดส่งให้ลูกค้า การตั้งค่านี้ใช้เฉพาะบัญชีที่เลือก</p>
    <label><input type="checkbox" checked={inbound} onChange={e => setInbound(e.target.checked)} /> อนุญาตรับข้อความของบัญชีนี้</label>
    <label><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> อนุญาตระบบส่งสำหรับขั้นทดสอบและเปิดใช้งาน</label>
    <Field label="รหัสผู้รับทดสอบที่ยินยอมแล้ว" hint="WhatsApp ใช้เบอร์พร้อมรหัสประเทศ, LINE ใช้ User ID, Facebook ใช้รหัสผู้ส่งที่ได้รับจากบัญชีนี้"><Input value={recipient} maxLength={200} onChange={e => setRecipient(e.target.value)} /></Field>
    <Button disabled={busy} variant="secondary" onClick={() => void run(() => api(path, { action: 'configure', revision: account.revision, inboundEnabled: inbound, liveEnabled: live, testRecipient: recipient }), 'บันทึกแล้ว ระบบส่งถูกปิดไว้จนกว่าจะตรวจและเปิดโหมดอีกครั้ง')}>บันทึกการรับและส่ง</Button>
    <div className="button-row"><Button disabled={busy} variant="secondary" onClick={() => void run(async () => { await api('/api/admin/social-accounts/' + account.id, { action: 'verify' }); await api(path, { action: 'verify' }); }, 'ตรวจบัญชีและกุญแจสำหรับส่งแล้ว')}>ตรวจบัญชีสำหรับส่ง</Button><Button disabled={busy} variant="ghost" onClick={() => void run(async () => { setStatus(await api(path)); }, 'ตรวจสถานะล่าสุดแล้ว')}>ดูสถานะการส่ง</Button></div>
    {status && <dl><dt>โหมดปัจจุบัน</dt><dd>{({ disabled: 'ปิดอยู่', test: 'เฉพาะผู้รับทดสอบ', live: 'เปิดส่งให้ลูกค้า' } as Record<string, string>)[status.sendMode] || status.sendMode}</dd><dt>รับข้อความที่ตรวจลายเซ็นแล้ว</dt><dd>{status.webhookVerified ? date(status.lastWebhookAt) : 'ยังไม่พบ'}</dd><dt>หลักฐานส่งทดสอบ</dt><dd>{status.testPassed ? 'ผ่าน' : 'ยังไม่ผ่าน'}</dd><dt>กุญแจและบัญชี</dt><dd>{status.verified ? 'ตรวจสอบแล้ว' : 'ต้องตรวจใหม่'}</dd></dl>}
    <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} /> ฉันตรวจบัญชีและผู้รับแล้ว ยืนยันการเปิดโหมดที่เลือก</label>
    <div className="button-row"><Button disabled={busy || !confirm} onClick={() => void run(() => api(path, { action: 'enable-test', confirm: true }), 'เปิดเฉพาะผู้รับทดสอบแล้ว เปิดบทสนทนาของผู้รับนั้นและส่งข้อความที่ตรวจทานแล้วเพื่อทดสอบ')}>เปิดเฉพาะผู้รับทดสอบ</Button><Button disabled={busy || !confirm} onClick={() => void run(() => api(path, { action: 'enable', confirm: true }), 'เปิดส่งแล้ว กลับไปขั้นสรุปเพื่อตรวจสถานะพร้อมใช้งาน')}>เปิดส่งให้ลูกค้า</Button><Button disabled={busy} variant="destructive" onClick={() => void run(() => api(path, { action: 'disable' }), 'หยุดส่งของบัญชีนี้แล้ว')}>หยุดส่งทันที</Button></div>
    {error && <p role="alert" className="alert alert-error">{error}</p>}{notice && <p role="status" className="helper-text">{notice}</p>}
  </section>;
}
