"use client";

import { useEffect, useRef, useState } from "react";
import { BriefcaseBusiness, Check, ChevronDown, Globe2, Monitor, Moon, RotateCcw, Settings, Sun, Type, X } from "lucide-react";
import type { Member } from "./data";
import "./account-preferences.css";

const fonts = ["TH Sarabun New", "Public Sans", "Inter", "DM Sans", "Nunito Sans"] as const;
type Font = typeof fonts[number];
type Preferences = { theme: "light" | "dark"; language: "th" | "en"; font: Font | null; textSize: number };
const defaults: Preferences = {theme:"light", language:"th", font:null, textSize:14};
const fontStack = (family: Font) => `"${family}", "Noto Sans Thai Variable", "Leelawadee UI", system-ui, sans-serif`;

function readPreferences(key: string): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    return { theme: saved?.theme === "dark" ? "dark" : "light", language: saved?.language === "en" ? "en" : "th",
      font: fonts.find(font => font === saved?.font) ?? null,
      textSize: Number.isInteger(saved?.textSize) && saved.textSize >= 12 && saved.textSize <= 20 ? saved.textSize : defaults.textSize };
  } catch { return defaults; }
}

export function usePreferences(employeeId?: string, enabled = true) {
  const key = employeeId ? "rrs.crm.preferences." + employeeId : "";
  const [preferences, setPreferences] = useState(defaults);
  function apply(value: Preferences) {
    document.documentElement.dataset.theme = value.theme;
    document.documentElement.lang = value.language;
    const style = document.documentElement.style;
    if (value.font) style.setProperty("--crm-ui-font", fontStack(value.font));
    else style.removeProperty("--crm-ui-font");
    if (value.textSize !== defaults.textSize) style.setProperty("--crm-text-unit", (value.textSize / defaults.textSize) + "px");
    else style.removeProperty("--crm-text-unit");
    setPreferences(value);
  }
  useEffect(() => {
    if (!enabled) return;
    apply(key ? readPreferences(key) : defaults);
    const sync = (event: StorageEvent) => { if (key && (event.key === key || event.key === null)) apply(readPreferences(key)); };
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("storage", sync); document.documentElement.lang="th"; delete document.documentElement.dataset.theme; document.documentElement.style.removeProperty("--crm-ui-font"); document.documentElement.style.removeProperty("--crm-text-unit"); };
  }, [key, enabled]);
  const change = (patch: Partial<Preferences>) => {
    const next = {...preferences, ...patch};
    apply(next);
    try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { /* Preferences still apply to this session. */ }
  };
  return { preferences, change };
}

type Props = ReturnType<typeof usePreferences> & { member: Member };
export function AccountPreferences({member,preferences,change}: Props) {
  const [open,setOpen] = useState<"account" | "settings" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const en = preferences.language === "en";
  const title = open === "settings" ? (en ? "Settings" : "ตั้งค่า") : (en ? "My account" : "บัญชีของฉัน");
  const initials = member.name.trim().split(/\s+/u).slice(0,2).map(part=>Array.from(part)[0]).join("").toLocaleUpperCase();
  function close() { setOpen(null); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(null); trigger.current?.focus(); } };
    document.addEventListener("pointerdown",outside); document.addEventListener("focusin",outside); document.addEventListener("keydown",escape);
    root.current?.querySelector<HTMLButtonElement>(".account-popover button")?.focus();
    return () => { document.removeEventListener("pointerdown",outside); document.removeEventListener("focusin",outside); document.removeEventListener("keydown",escape); };
  },[open]);
  const toggle = (panel: typeof open, button: HTMLButtonElement) => { trigger.current=button; setOpen(open === panel ? null : panel); };
  return <div className="account-controls" ref={root}>
    <button className="account-trigger" type="button" aria-label={en?"My account":"บัญชีของฉัน"} aria-expanded={open==="account"} aria-haspopup="dialog" onClick={e=>toggle("account",e.currentTarget)}><span className="account-avatar">{initials}</span><ChevronDown size={15}/></button>
    <button className="pref-trigger" type="button" aria-label={en?"Settings":"ตั้งค่า"} aria-haspopup="dialog" aria-expanded={open==="settings"} onClick={e=>toggle("settings",e.currentTarget)}><Settings size={20}/></button>
    {open && <section className="account-popover" role="dialog" aria-label={title}>
      <header><h2>{title}</h2><button className="account-close" type="button" aria-label={en?"Close":"ปิด"} onClick={close}><X size={17}/></button></header>
      {open==="account" ? <div className="employee-summary"><span className="account-avatar">{initials}</span><div><strong>{member.name}</strong><p><BriefcaseBusiness size={16}/>{member.jobTitle || (en?"Job title not set":"ยังไม่ระบุตำแหน่ง")}</p><small>{en?"Access":"สิทธิ์"} · {member.role}</small></div></div> : <>
      <div className="pref-group" role="group" aria-label={en?"Theme":"ธีม"}><h3><Monitor size={16}/>{en?"Theme":"ธีม"}</h3><div className="theme-options">{(["light","dark"] as const).map(theme=><button type="button" key={theme} aria-pressed={preferences.theme===theme} onClick={()=>change({theme})}><span className={"theme-preview preview-"+theme} aria-hidden="true"><i/><b/><em/></span><span>{theme==="light"?<Sun size={15}/>:<Moon size={15}/>} {theme==="light"?(en?"Light":"สว่าง"):(en?"Dark":"มืด")}{preferences.theme===theme && <Check size={15}/>}</span></button>)}</div></div>
      <div className="pref-group" role="group" aria-label={en?"Language":"ภาษา"}><h3><Globe2 size={16}/>{en?"Language":"ภาษา"}</h3><div className="language-options">{(["th","en"] as const).map(language=><button key={language} lang={language} type="button" aria-pressed={preferences.language===language} onClick={()=>change({language})}>{language==="th"?"ไทย":"English"}{language===preferences.language&&<Check size={15}/>}</button>)}</div></div>
      <div className="pref-group type-group" role="group" aria-label={en ? "Font" : "แบบอักษร"}>
        <h3><Type size={16}/>{en ? "Font" : "แบบอักษร"}</h3>
        <div className="font-options">{fonts.map(font => <button type="button" key={font} aria-label={font} aria-pressed={preferences.font===font} onClick={()=>change({font})}>
          <span aria-hidden="true" style={{fontFamily:fontStack(font)}}>Aa</span>
          <span>{font}</span>{preferences.font===font && <Check size={15} aria-hidden="true"/>}
        </button>)}</div>
      </div>
      <div className="pref-group font-size-group">
        <label htmlFor="crm-text-size">{en ? "Text size" : "ขนาดข้อความ"} <output htmlFor="crm-text-size">{preferences.textSize} px</output></label>
        <input id="crm-text-size" type="range" min="12" max="20" step="1" value={preferences.textSize} aria-valuetext={preferences.textSize+" px"} onChange={e=>change({textSize:Number(e.currentTarget.value)})}/>
        <button className="type-reset" type="button" onClick={()=>change({font:defaults.font, textSize:defaults.textSize})}><RotateCcw size={14}/>{en ? "Reset typography" : "คืนค่าแบบอักษรและขนาด"}</button>
      </div></>}
    </section>}
  </div>;
}
