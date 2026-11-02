/* Only public visual assets are cached. Chats, APIs, HTML and authentication never enter Cache Storage. */
const CACHE='rrs-public-v1';
const PUBLIC=new Set(['/rrs-app.svg','/fonts/noto-sans-thai-thai-wght-normal.woff2','/fonts/noto-sans-thai-latin-wght-normal.woff2']);
self.addEventListener('install',event=>{event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("rrs-public-")&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.search||!PUBLIC.has(url.pathname))return;event.respondWith(caches.open(CACHE).then(async cache=>{const cached=await cache.match(request);if(cached)return cached;const response=await fetch(request);if(response.ok&&response.type==='basic'&&!/private|no-store/i.test(response.headers.get('cache-control')||''))await cache.put(request,response.clone());return response;}));});
