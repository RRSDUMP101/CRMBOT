/** Canonical record hash shared by negotiated CRM envelope v2 producers/consumers. */
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export async function bridgeRecordHash(value:unknown){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
 return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

