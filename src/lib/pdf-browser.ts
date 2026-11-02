/** Uses PDF.js in the browser; original documents are never sent to a third party. */
export async function extractPdfInBrowser(file:File){
 if(file.size>5*1024*1024)throw new Error('PDF ต้องไม่เกิน 5 MB');
 const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc='/pdf.worker.min.mjs';
 const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),useSystemFonts:true,disableFontFace:true});
 try{const pdf=await task.promise;if(pdf.numPages>100)throw new Error('รองรับ PDF ไม่เกิน 100 หน้า');let text='';
  for(let page=1;page<=pdf.numPages;page++){const data=await (await pdf.getPage(page)).getTextContent();text+=data.items.map(item=>'str'in item?item.str:'').join(' ')+'\n';if(text.length>100000)throw new Error('เนื้อหาต้องไม่เกิน 100,000 ตัวอักษร');}
  if(!text.trim())throw new Error('PDF นี้ไม่มีชั้นข้อความ กรุณาแปลงภาพด้วย OCR ก่อนอัปโหลด');return text.trim();
 }finally{await task.destroy();}
}
