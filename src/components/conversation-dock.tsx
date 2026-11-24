"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Expand, MessageSquare, Minimize2, X } from "lucide-react";
import { InboxWorkspace } from "./inbox-workspace";
import { api } from "./data";
import type { InboxResult } from "./inbox-data";
import type { PanelProps } from "./workspace";
import { subscribeCRMChanges } from "./realtime";

export function ConversationDock(props: PanelProps) {
  const [room, setRoom] = useState("");
  const [size, setSize] = useState<"closed" | "mini" | "room" | "inbox">("closed");
  const [notice, setNotice] = useState<{id:string; name:string; count:number} | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const [activeRoom, setActiveRoom] = useState("");
  const previous = useRef<Map<string, string | null> | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = useCallback((id: string) => {
    if (!id) return;
    returnFocus.current = document.activeElement as HTMLElement;
    setHost(document.querySelector("dialog[open]") || document.body);
    setRoom(id); setActiveRoom(id); setSize("room"); setNotice(null);
    if (matchMedia("(max-width: 760px)").matches && !history.state?.rrsChatDock)
      history.pushState({...history.state,rrsChatDock:true}, "");
  }, []);
  const close = () => {
    if (history.state?.rrsChatDock) history.back();
    else {setSize("closed"); returnFocus.current?.focus({preventScroll:true});}
  };
  useEffect(() => {
    const onOpen = (event: Event) => {
      const {conversationId,leadId,customerId} = (event as CustomEvent).detail || {};
      const id = conversationId || props.data.conversations.find(c => c.leadId === (leadId || customerId))?.id;
      if (id) open(id); else props.notify("ยังไม่มีบทสนทนาที่เชื่อมกับลูกค้ารายนี้");
    };
    const back = () => {setSize("closed"); returnFocus.current?.focus({preventScroll:true});};
    window.addEventListener("rrs:open-chat",onOpen); window.addEventListener("popstate",back);
    return () => {window.removeEventListener("rrs:open-chat",onOpen);window.removeEventListener("popstate",back);};
  }, [open, props.data.conversations, props.notify]);
  useEffect(() => {
    let alive = true, busy = false;
    const check = async () => {
      if (busy) return; busy = true;
      try {
        const {items} = await api<InboxResult>("/api/admin/inbox?view=unread&limit=25");
        if (!alive) return;
        const changed = previous.current && items.find(i => i.lastCustomerMessageId && previous.current?.get(i.id) !== i.lastCustomerMessageId);
        previous.current = new Map(items.map(i => [i.id,i.lastCustomerMessageId]));
        if (changed) {setNotice({id:changed.id,name:changed.leadName || "ลูกค้า",count:changed.unreadCount});setHost(document.querySelector("dialog[open]") || document.body);}
      } catch { /* Leave the current document and input focus intact while offline. */ }
      finally {busy = false;}
    };
    void check(); const unsubscribe = subscribeCRMChanges(check); const timer = setInterval(check,12000);
    return () => {alive = false;clearInterval(timer);unsubscribe();};
  }, []);
  if (!host) return null;
  return createPortal(<>
    {notice && (size !== "room" && size !== "inbox" || activeRoom !== notice.id) && <button type="button" className="chat-dock-notice" onClick={() => open(notice.id)}><MessageSquare size={17}/> {notice.name} · {notice.count} ข้อความใหม่</button>}
    {room && <section className={"chat-dock chat-dock-"+size} hidden={size === "closed" || size === "mini"} aria-label="แชทลูกค้า">
      <header><strong>{size === "inbox" ? "กล่องข้อความ" : "แชทลูกค้า"}</strong>
        <button type="button" aria-label="ย่อแชท" onClick={() => setSize("mini")}><Minimize2 size={17}/></button>
        <button type="button" aria-label={size === "room" ? "ขยายเข้า Inbox" : "กลับหน้าต่างแชท"} onClick={() => setSize(size === "room" ? "inbox" : "room")}><Expand size={17}/></button>
        <button type="button" aria-label="กลับไปทำงาน" onClick={close}><X size={18}/></button></header>
      <InboxWorkspace {...props} requestedRoom={room} onRoomChange={setActiveRoom} visible={size === "room" || size === "inbox"}/>
    </section>}
    {size === "mini" && <button type="button" className="chat-dock-bubble" aria-label="เปิดแชทที่ย่อไว้" onClick={() => {setSize("room");setNotice(null);}}><MessageSquare size={24}/>{notice?.id === activeRoom && <b>{notice.count}</b>}</button>}
  </>, host.isConnected ? host : document.body);
}
