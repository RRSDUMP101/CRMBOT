import type { Conversation } from "./data";

export type InboxQueue = "all" | "mine" | "unassigned" | "waiting" | "closed" | "unread";
export type InboxItem = Conversation & { unreadCount: number; lastCustomerMessageId: string | null };
export type InboxResult = { items: InboxItem[]; nextCursor: string | null; total: number; counts: Record<InboxQueue, number> };
export type ReplyTemplate = { id: string; title: string; shortcut: string; content: string; category: string; version: number; updatedAt: string };
export const queueNames: Record<InboxQueue, string> = { all: "เปิดอยู่", mine: "ของฉัน", unassigned: "ยังไม่มอบหมาย", waiting: "รอทีม", closed: "จบแล้ว", unread: "ยังไม่อ่าน" };
export const emptyCounts: Record<InboxQueue, number> = { all: 0, mine: 0, unassigned: 0, waiting: 0, closed: 0, unread: 0 };
