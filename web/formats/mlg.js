// MLVLG v1/v2 implementation from EFI Analytics' published specifications:
// https://www.efianalytics.com/TunerStudio/docs/MLG_Binary_LogFormat_1.0.pdf
// https://www.efianalytics.com/TunerStudio/docs/MLG_Binary_LogFormat_2.0.pdf
const text=new TextDecoder();
const sizes={0:1,1:1,2:2,3:2,4:4,5:4,6:8,7:4,10:1,11:2,12:4};
export function parseMlg(input){
 const b=new Uint8Array(input),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
 const str=(p,n)=>text.decode(b.subarray(p,p+n)).split('\0')[0];
 if(b.length<22||str(0,6)!=='MLVLG'||b[5]!==0)throw Error('Not an MLVLG log');
 const version=v.getUint16(6);
 if(version!==1&&version!==2)throw Error('Unsupported MLVLG version '+version);
 const header=version===1?22:24,descriptor=version===1?55:89;
 if(b.length<header)throw Error('Truncated MLG header');
 const start=v.getUint32(header-8),length=v.getUint16(header-4),count=v.getUint16(header-2);
 if(!count||header+descriptor*count>start||start>b.length)throw Error('Invalid MLG field directory');
 const fields=[];let width=0;
 for(let i=0;i<count;i++){
  const p=header+descriptor*i,type=b[p],size=sizes[type];if(!size)throw Error('Unsupported MLG field type '+type);
  fields.push({name:str(p+1,34)||`Field ${i+1}`,unit:str(p+35,10),type,size,offset:width,scale:type>=10?1:v.getFloat32(p+46),shift:type>=10?0:v.getFloat32(p+50),digits:type>=10?0:v.getInt8(p+54)});width+=size;
  if(type>=10){
   const f=fields.at(-1);f.hidden=!str(p+1,34);f.bits=[];
   const bitCount=b[p+51];let names=v.getUint32(p+47);
   if(bitCount>size*8)throw Error('Invalid MLG bit count');
   for(let bit=0;bit<bitCount;bit++){
    if(names<header+descriptor*count||names>=start)throw Error('Invalid MLG bit-name directory');
    const end=b.indexOf(0,names);if(end<names||end>=start)throw Error('Unterminated MLG bit name');
    const name=str(names,end-names);if(name&&name!=='INVALID')f.bits.push({name,bit});names=end+1;
   }
  }
 }
 if(width!==length)throw Error('MLG record width mismatch');
 const records=[],markers=[];let rejected=0,previous,wrap=0;
 for(let p=start;p<b.length;){
  if(p+4>b.length)throw Error('Truncated MLG record');
  const type=b[p],stamp=v.getUint16(p+2);
  // Marker timestamps may be zero (unspecified); they must not advance the clock.
  if(type===0){if(previous!==undefined&&stamp<previous)wrap+=65536;previous=stamp;}
  const seconds=(wrap+stamp)*0.00001;
  if(type===1){if(p+54>b.length)throw Error('Truncated MLG marker');markers.push({t:seconds,text:str(p+4,50),record:records.length});p+=54;continue;}
  if(type!==0)throw Error('Unknown MLG record type '+type);
  if(p+length+5>b.length)throw Error('Truncated MLG data');
  let checksum=0;for(let q=p+4;q<p+4+length;q++)checksum=(checksum+b[q])&255;
  if(checksum===b[p+4+length])records.push({offset:p+4,time:seconds});else rejected++;
  p+=length+5;
 }
 if(!records.length)throw Error('MLG contains no valid records');
 const expandedCount=fields.reduce((n,f)=>n+1+(f.bits?.length||0),1);
 if(records.length*expandedCount>64000000)throw Error('MLG exceeds the browser sample limit');
 const data=Array.from({length:count+1},()=>new Float64Array(records.length));
 for(let r=0;r<records.length;r++){
  data[0][r]=records[r].time-records[0].time;
  for(let c=0;c<count;c++){
   const f=fields[c],p=records[r].offset+f.offset;let raw;
   switch(f.type){case 0:case 10:raw=v.getUint8(p);break;case 1:raw=v.getInt8(p);break;case 2:case 11:raw=v.getUint16(p);break;case 3:raw=v.getInt16(p);break;case 4:case 12:raw=v.getUint32(p);break;case 5:raw=v.getInt32(p);break;case 6:raw=Number(v.getBigInt64(p));if(!Number.isSafeInteger(raw))throw Error('MLG int64 exceeds JavaScript precision');break;case 7:raw=v.getFloat32(p);}
   data[c+1][r]=(raw+f.shift)*f.scale;
  }
 }
 const clock=fields.findIndex(f=>/^(time|time \(sec\)|seconds)$/i.test(f.name)&&/^(s|sec|seconds)?$/i.test(f.unit));
 if(clock>=0){const origin=data[clock+1][0];data[0]=Float64Array.from(data[clock+1],x=>x-origin);}
 // Anchor markers to the next valid sample, including logs with an explicit time channel.
 for(const marker of markers){marker.t=data[0][Math.min(marker.record,records.length-1)];delete marker.record;}
 const outputFields=[],outputData=[data[0]];
 fields.forEach((f,i)=>{
  if(!f.hidden){outputFields.push(f);outputData.push(data[i+1]);}
  for(const bit of f.bits||[]){outputFields.push({name:bit.name,unit:'',digits:0,type:10});outputData.push(Float64Array.from(data[i+1],x=>(x>>>bit.bit)&1));}
 });
 return {parsed:{channels:[{name:'Time (sec)',dp:5},...outputFields.map(f=>({name:f.name,dp:f.digits}))],data:outputData,time:data[0],rows:records.length,needsFinish:'mlg'},meta:{version,field_count:count,record_count:records.length,rejected_checksum:rejected,units:['s',...outputFields.map(f=>f.unit)],digits:[5,...outputFields.map(f=>f.digits)],bitfield:[false,...outputFields.map(f=>f.type>=10)],markers,time_source:clock>=0?'channel':'clock',time_channel:clock>=0?fields[clock].name:null}};
}
