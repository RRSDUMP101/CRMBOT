import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {extractPdfInBrowser} from '../src/lib/pdf-browser';
function pdf(text:string){
 const stream=text?`BT /F1 12 Tf 30 60 Td (${text}) Tj ET`:'';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let output='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(output.length);output+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=output.length;output+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return new File([output],'fixture.pdf',{type:'application/pdf'});
}
test('real PDF.js text parser reads a valid PDF and rejects pages requiring OCR; self-hosted worker matches pinned package',async()=>{
 // Node's legacy entry supplies DOM geometry globals. Parsing uses the real same-version worker module.
 await import('pdfjs-dist/legacy/build/pdf.mjs');
 // @ts-expect-error PDF.js ships its executable worker without a TypeScript declaration.
 (globalThis as any).pdfjsWorker=await import('pdfjs-dist/build/pdf.worker.mjs');
 assert.match(await extractPdfInBrowser(pdf('RRS fixture knowledge')),/RRS fixture knowledge/);
 await assert.rejects(extractPdfInBrowser(pdf('')),/OCR/);
 const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');assert.equal(sha('public/pdf.worker.min.mjs'),sha('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'));
});
