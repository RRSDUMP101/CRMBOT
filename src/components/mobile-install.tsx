'use client';
import {useEffect,useState} from 'react';
type InstallEvent=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:string}>};
export function MobileInstall(){const [install,setInstall]=useState<InstallEvent|null>(null);useEffect(()=>{if('serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});const offer=(e:Event)=>{e.preventDefault();setInstall(e as InstallEvent);};window.addEventListener('beforeinstallprompt',offer);return()=>window.removeEventListener('beforeinstallprompt',offer);},[]);return install?<button className="button button-secondary" onClick={async()=>{await install.prompt();await install.userChoice;setInstall(null);}}>เพิ่ม RRS Connect ลงหน้าจอหลัก</button>:null;}
