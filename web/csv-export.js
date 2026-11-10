// Native-value CSV using the same channel/type convention as Haltech NSP.
// Values remain in the channel's native representation; Type carries scaling.
function clean(value){return String(value??'').replace(/[\r\n]+/g,' ');}
function stamp(seconds){
 const ms=Math.round(seconds*1000),day=((ms%86400000)+86400000)%86400000;
 return `${String(Math.floor(day/3600000)).padStart(2,'0')}:${String(Math.floor(day/60000)%60).padStart(2,'0')}:${String(Math.floor(day/1000)%60).padStart(2,'0')}.${String(day%1000).padStart(3,'0')}`;
}
export function* exportCsvChunks(log,chunkRows=512){
 if(!log?.time?.length||!log.channels?.length)throw Error('Open a log before exporting CSV.');
 const channels=log.channels.filter(c=>!c.isMath&&log.data[c.idx]);
 if(!channels.length)throw Error('No recorded channel data is available.');
 const header=['%DataLog%','DataLogVersion : 1.1','Software : Open Log Viewer'];
 for(const c of channels){header.push(`Channel : ${clean(c.name)}`,`Type : ${clean(c.type||'Other')}`);if(Number.isFinite(c.max)&&Number.isFinite(c.min))header.push(`DisplayMaxMin : ${c.max},${c.min}`);}
 yield header.join('\r\n')+'\r\n';
 let lines=[];
 for(let r=0;r<log.time.length;r++){
  const row=[stamp(log.time[r])];
  for(const c of channels){const error=log.errCodes?.[c.idx]?.[r],value=error||log.data[c.idx][r];row.push(Number.isFinite(value)?String(value):'');}
  lines.push(row.join(','));
  if(lines.length>=chunkRows){yield lines.join('\r\n')+'\r\n';lines=[];}
 }
 if(lines.length)yield lines.join('\r\n')+'\r\n';
}
export async function downloadCsv(log){
 const chunks=[];let n=0;
 for(const chunk of exportCsvChunks(log)){chunks.push(chunk);if(++n%8===0)await new Promise(resolve=>setTimeout(resolve,0));}
 const url=URL.createObjectURL(new Blob(chunks,{type:'text/csv;charset=utf-8'}));
 const link=document.createElement('a');link.href=url;link.download=(log.name||'log').replace(/\.[^.]+$/,'')+'-export.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
