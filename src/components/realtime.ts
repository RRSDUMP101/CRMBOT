"use client";

const listeners=new Set<()=>void>();
let connection:EventSource|undefined;
/** Share one staff stream across inbox, selected conversation and dashboard. */
export function subscribeCRMChanges(listener:()=>void){
  listeners.add(listener);
  if(!connection){
    connection=new EventSource('/api/admin/events');
    connection.addEventListener('change',()=>{for(const current of listeners)current();});
    connection.addEventListener('auth-required',()=>{connection?.close();connection=undefined;for(const current of listeners)current();});
  }
  return ()=>{listeners.delete(listener);if(!listeners.size){connection?.close();connection=undefined;}};
}
