import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { widgetDocument } from '../src/lib/widget-document';

class Element {
  id='';className='';value='';disabled=false;checked=true;removed=false;scrollTop=0;scrollHeight=0;
  style:Record<string,any>={setProperty(){}};children:Element[]=[];parent:Element|null=null;
  elements:Record<string,Element>={};onclick?:()=>unknown;onsubmit?:(event:{preventDefault():void})=>unknown;onkeydown?:unknown;
  private ownText='';
  get textContent():string{return this.ownText+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.ownText=String(value);this.replaceChildren();}
  append(...elements:Element[]){for(const element of elements){element.remove();element.removed=false;element.parent=this;this.children.push(element);}}
  replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;this.removed=true;}
  focus(){}
  querySelector(selector:string):Element|null {
    if(selector==='[type=submit]')return this.elements.submit||null;
    for(const child of this.children){if(selector.startsWith('.')&&child.className.split(' ').includes(selector.slice(1)))return child;const found=child.querySelector(selector);if(found)return found;}return null;
  }
}
type RequestRecord={path:string;options:RequestInit};
const response=(data:unknown,status=200)=>Response.json(data,{status});
const data=(version=1,status='bot_active',messages:unknown[]=[])=>({conversation:{id:'conversation',version,status},messages,settings:{aiEnabled:true},demo:true,provider:'demo'});
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

function runtime(handler:(request:RequestRecord)=>Promise<Response>|Response) {
  const nodes=new Map<string,Element>();
  for(const id of ['title','greeting','notice','error-text','error','retry','close','status','handoff','mode','messages','send','text','quick','composer','contact','contact-open','contact-cancel']){const node=new Element();node.id=id;nodes.set(id,node);}
  for(const key of ['name','phone','email','consent','submit'])nodes.get('contact')!.elements[key]=new Element();
  const find=(id:string,element:Element):Element|null=>{if(element.id===id&&!element.removed)return element;for(const child of element.children){const result=find(id,child);if(result)return result;}return null;};
  const document={documentElement:new Element(),referrer:'https://allowed.example/',addEventListener(){},querySelectorAll(){return [];},createElement(){return new Element();},getElementById(id:string){const fixed=nodes.get(id);if(fixed&&!fixed.removed)return fixed;for(const node of nodes.values()){const result=find(id,node);if(result)return result;}return null;}};
  const requests:RequestRecord[]=[];const intervals:Array<()=>void>=[];
  const context=createContext({document,window:{parent:{postMessage(){}}},crypto:{randomUUID},AbortController,TextDecoder,URL,console,
    setInterval(fn:()=>void){intervals.push(fn);return intervals.length;},
    fetch(path:string,options:RequestInit={}){const request={path,options};requests.push(request);return handler(request);}
  });
  const html=widgetDocument({title:'RRS',greeting:'สวัสดี',accentColor:'#24bfa6',position:'right',enabled:true});
  new Script(html.match(/<script>([\s\S]*)<\/script>/)![1]).runInContext(context);
  return {nodes,requests,poll(){intervals[0]();},send(text:string){nodes.get('text')!.value=text;nodes.get('composer')!.onsubmit!({preventDefault(){}});}};
}

function streamed() {
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const body=new ReadableStream<Uint8Array>({start(value){controller=value;}});const encoder=new TextEncoder();
  return {response:new Response(body,{headers:{'Content-Type':'text/event-stream'}}),event(event:unknown){controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));},close(){controller.close();}};
}

test('concurrent first contact and handoff share one session and wait for cookie verification',async()=>{
  const session=deferred<Response>();const verification=deferred<Response>();let sessionStarted=false;let verified=false;
  const app=runtime(request=>{
    if(request.path==='/api/chat/session'){sessionStarted=true;return session.promise;}
    if(request.path==='/api/chat')return !sessionStarted?response({error:'No session'},401):verified?response(data()):verification.promise;
    assert.equal(verified,true,'mutations must wait until the session cookie is verified');return response({ok:true});
  });
  await settle();
  const handoff=app.nodes.get('handoff')!.onclick!();
  const contact=app.nodes.get('contact')!.onsubmit!({preventDefault(){}});
  await settle();assert.equal(app.requests.filter(request=>request.path==='/api/chat/session').length,1);
  session.resolve(response(data()));await settle();
  assert.equal(app.requests.filter(request=>request.path==='/api/chat/handoff'||request.path==='/api/chat/contact').length,0);
  verified=true;verification.resolve(response(data()));await Promise.all([handoff,contact]);
  assert.equal(app.requests.filter(request=>request.path==='/api/chat/session').length,1);
  assert.equal(app.requests.filter(request=>request.path==='/api/chat/handoff').length,1);
  assert.equal(app.requests.filter(request=>request.path==='/api/chat/contact').length,1);
});

test('older poll responses cannot rewind messages or epoch and failed answers stay visibly incomplete',async()=>{
  const failed={id:'partial',role:'assistant',content:'Partial answer',status:'failed'};
  const newer={id:'agent',role:'agent',content:'New staff message',status:'complete'};
  const oldPoll=deferred<Response>(),newPoll=deferred<Response>();let calls=0;
  const app=runtime(()=>{calls++;return calls===1?response(data(2,'human_active',[failed])):calls===2?oldPoll.promise:calls===3?newPoll.promise:response(data(1,'bot_active',[]));});
  await settle();assert.match(app.nodes.get('messages')!.textContent,/คำตอบไม่สมบูรณ์/);
  app.poll();app.poll();
  newPoll.resolve(response(data(2,'human_active',[failed,newer])));await settle();
  oldPoll.resolve(response(data(2,'human_active',[failed])));await settle();
  assert.match(app.nodes.get('messages')!.textContent,/New staff message/);
  app.poll();await settle();
  assert.match(app.nodes.get('messages')!.textContent,/New staff message/);
  assert.match(app.nodes.get('status')!.textContent,/เจ้าหน้าที่รับช่วงแล้ว/);
});

test('late cancelled stream events and cleanup cannot clear a newer send',async()=>{
  const oldStream=streamed(),newStream=streamed();let snapshot=data();let sends=0;
  const app=runtime(request=>{
    if(request.path==='/api/chat')return response(snapshot);
    if(request.path==='/api/chat/message')return ++sends===1?oldStream.response:newStream.response;
    throw new Error(`Unexpected request ${request.path}`);
  });
  await settle();app.send('First question');await settle();oldStream.event({type:'meta',version:2});await settle();
  snapshot=data(3,'human_active');app.poll();await settle();assert.equal(app.nodes.get('send')!.disabled,false);
  snapshot=data(4,'bot_active');app.poll();await settle();
  app.send('Second question');await settle();newStream.event({type:'meta',version:5});await settle();
  // Model a transport that settles late after abort; old buffered events must have no ownership.
  oldStream.event({type:'meta',version:2});oldStream.event({type:'token',version:2,text:'STALE'});oldStream.event({type:'done'});oldStream.close();await settle();
  assert.equal(app.nodes.get('send')!.disabled,true,'old finally must not re-enable the new request');
  newStream.event({type:'token',version:5,text:'NEW ANSWER'});await settle();
  assert.match(app.nodes.get('messages')!.textContent,/NEW ANSWER/);assert.doesNotMatch(app.nodes.get('messages')!.textContent,/STALE/);
  snapshot=data(5,'bot_active',[{id:'new-answer',role:'assistant',content:'NEW ANSWER',status:'complete'}]);
  newStream.event({type:'done'});newStream.close();await settle();await settle();
  assert.equal(app.nodes.get('send')!.disabled,false);assert.match(app.nodes.get('messages')!.textContent,/NEW ANSWER/);
});
