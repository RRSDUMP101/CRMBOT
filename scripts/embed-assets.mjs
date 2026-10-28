import {readdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root='.open-next/assets';const assets={};
const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.txt':'text/plain; charset=utf-8','.html':'text/html; charset=utf-8','.rsc':'text/x-component'};
async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await walk(file);else{const key='/'+path.relative(root,file).replaceAll(path.sep,'/');assets[key]=[(await readFile(file)).toString('base64'),types[path.extname(file)]||'application/octet-stream'];}}}
await walk(root);
await writeFile('.open-next/embedded-assets.mjs','export default '+JSON.stringify(assets)+';\n');
console.log(`Packaged ${Object.keys(assets).length} public build assets. No customer files are included.`);
