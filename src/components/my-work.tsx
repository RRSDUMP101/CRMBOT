'use client';

import {useState} from 'react';
import {date, localDate} from './data';
import {Badge, Card} from './ui';
import {Tasks} from './workspace-panels';
import type {PanelProps} from './workspace';

export function MyWork({data, reload, notify}: PanelProps) {
  const [group, setGroup] = useState<'chats' | 'tasks'>('chats');
  const today = localDate(new Date().toISOString()).slice(0, 10);
  const assigned = (item: {assigneeId: string | null}) => item.assigneeId === data.user.id;
  const chats = data.conversations.filter(room => assigned(room) && room.status === 'waiting_human');
  const tasks = data.tasks.filter(task => assigned(task) && ['open', 'pending', 'confirmed'].includes(task.status)
    && localDate(task.dueAt).slice(0, 10) === today);
  const leadNames = new Map(data.leads.map(lead => [lead.id, lead.name]));
  return <Card className="my-work">
    <div className="card-heading"><h2>งานของฉัน</h2><span>{date(new Date().toISOString(), false)}</span></div>
    <div className="segmented" aria-label="เลือกประเภทงาน">
      <button type="button" aria-pressed={group === 'chats'} className={group === 'chats' ? 'active' : ''} onClick={() => setGroup('chats')}>
        แชทรอตอบ <Badge>{chats.length}</Badge>
      </button>
      <button type="button" aria-pressed={group === 'tasks'} className={group === 'tasks' ? 'active' : ''} onClick={() => setGroup('tasks')}>
        ติดตามวันนี้ <Badge>{tasks.length}</Badge>
      </button>
    </div>
    {group === 'chats' && <div className="activity-list">
      {chats.map(room => <a className="activity-row" key={room.id} href={'?conversation=' + encodeURIComponent(room.id) + '#inbox'}>
        <div><strong>{leadNames.get(room.leadId) || room.leadName || 'ลูกค้า'}</strong><small>{room.lastMessage}</small></div>
        <span>{date(room.updatedAt)}</span>
      </a>)}
      {!chats.length && <p>ยังไม่มีแชทที่มอบหมายให้คุณและรอคำตอบ</p>}
    </div>}
    {group === 'tasks' && (tasks.length ? <Tasks data={{...data, tasks}} reload={reload} notify={notify}/> : <p>วันนี้ไม่มีงานติดตามที่มอบหมายให้คุณ</p>)}
    {((group === 'chats' && data.conversations.length >= 1000) || (group === 'tasks' && data.tasks.length >= 2000)) &&
      <p>จำนวนนี้นับจากรายการที่โหลดใน CRM</p>}
  </Card>;
}
