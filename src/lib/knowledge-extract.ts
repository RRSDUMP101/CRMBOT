import { Inflate } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { ApiError } from './auth';

const LIMIT=8_000_000, TEXT_LIMIT=100_000;
const fail=()=>new ApiError(422,'ไฟล์เสียหาย เข้ารหัส หรือเกินขีดจำกัดการอ่าน');
/** Validate the central directory before any inflation; then enforce actual output limits. */
function officeParts(bytes:Uint8Array):Map<string,string>{
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=(n:number)=>view.getUint16(n,true),u32=(n:number)=>view.getUint32(n,true);
 let end=-1;for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(u32(p)===0x06054b50){end=p;break;}
 if(end<0||u16(end+4)||u16(end+6)||u16(end+10)>300||u16(end+10)!==u16(end+8))throw fail();
 let p=u32(end+16),total=0;const result=new Map<string,string>();
 for(let n=0;n<u16(end+10);n++){
  if(p+46>end||u32(p)!==0x02014b50)throw fail();
  const flags=u16(p+8),method=u16(p+10),compressed=u32(p+20),size=u32(p+24),nameSize=u16(p+28),extra=u16(p+30),comment=u16(p+32),local=u32(p+42);
  if((flags&1)||![0,8].includes(method)||size>LIMIT||(total+=size)>LIMIT||p+46+nameSize+extra+comment>end)throw fail();
  const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(p+46,p+46+nameSize));p+=46+nameSize+extra+comment;
  if(name.includes('..')||name.startsWith('/')||result.has(name))throw fail();
  if(!/^word\/document\.xml$|^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name))continue;
  if(local+30>=bytes.length||u32(local)!==0x04034b50||u16(local+8)!==method)throw fail();
  const start=local+30+u16(local+26)+u16(local+28);if(start+compressed>u32(end+16))throw fail();
  const chunks:Uint8Array[]=[];let actual=0;
  const accept=(chunk:Uint8Array)=>{actual+=chunk.length;if(actual>size||actual>LIMIT)throw fail();chunks.push(chunk);};
  if(method===0)accept(bytes.subarray(start,start+compressed));else{
   const inflate=new Inflate(accept);for(let i=0;i<compressed;i+=1024)inflate.push(bytes.subarray(start+i,Math.min(start+i+1024,start+compressed)),i+1024>=compressed);
  }
  if(actual!==size)throw fail();const out=new Uint8Array(actual);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(out);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw fail();
  let depth=0,tokens=0;for(const match of xml.matchAll(/<([^>]+)>/g)){if(++tokens>100000)throw fail();const tag=match[1];if(tag.startsWith('?')||tag.startsWith('!'))continue;if(tag.startsWith('/'))depth--;else if(!tag.endsWith('/'))depth++;if(depth<0||depth>64)throw fail();}
  result.set(name,xml);
 }
 return result;
}
const array=(value:unknown):any[]=>value===undefined?[]:Array.isArray(value)?value:[value];
function textNodes(value:any):string{if(value===undefined||value===null)return '';if(typeof value!=='object')return String(value);return Object.entries(value).filter(([key])=>!key.startsWith('@_')).map(([,v])=>array(v).map(textNodes).join('')).join('');}
export async function extractKnowledge(bytes:Uint8Array,ext:string):Promise<string>{
 if(ext==='pdf')throw new ApiError(422,'กรุณาอัปโหลด PDF ผ่านหน้าฐานความรู้เพื่ออ่านเอกสารในเบราว์เซอร์');
 try{
  const parts=officeParts(bytes),parser=new XMLParser({ignoreAttributes:false,processEntities:false,parseTagValue:false,trimValues:false});let content='';
  if(ext==='docx'){
   const xml=parts.get('word/document.xml');if(!xml)throw fail();const doc=parser.parse(xml);
   const walk=(v:any):void=>{if(!v||typeof v!=='object')return;for(const [key,value] of Object.entries(v)){if(key==='w:p')for(const p of array(value))content+=textNodes(p)+'\n';else for(const child of array(value))walk(child);}};walk(doc);
  }else if(ext==='xlsx'){
   const shared=parts.get('xl/sharedStrings.xml'),strings=shared?array(parser.parse(shared)?.sst?.si).map(textNodes):[];
   for(const [name,xml] of parts){if(!name.startsWith('xl/worksheets/'))continue;content+='\n'+name+'\n';for(const row of array(parser.parse(xml)?.worksheet?.sheetData?.row)){content+=array(row.c).map(cell=>cell['@_t']==='s'?strings[Number(cell.v)]||'':cell['@_t']==='inlineStr'?textNodes(cell.is):textNodes(cell.v)).join('\t')+'\n';if(content.length>TEXT_LIMIT)throw fail();}}
  }else throw fail();
  content=content.trim();if(!content||content.length>TEXT_LIMIT)throw fail();return content;
 }catch(error){if(error instanceof ApiError)throw error;throw fail();}
}
