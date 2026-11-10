// HLG framing recovered from a real Nexus PC log. Record lengths include the
// one-byte tag and four-byte big-endian length. Payload interpretation is ongoing.
export function* readHlgRecords(input) {
 const bytes=Buffer.from(input);
 let offset=0;
 while(offset<bytes.length){
  if(bytes.length-offset<5)throw new Error(`Truncated HLG header at ${offset}`);
  const type=bytes[offset],length=bytes.readUInt32BE(offset+1);
  if(length<5||length>bytes.length-offset)throw new Error(`Invalid HLG record length at ${offset}`);
  yield {offset,type,length,payload:bytes.subarray(offset+5,offset+length)};
  offset+=length;
 }
}
