import {deflateRawSync} from 'node:zlib';
export function zipFixture(name, text, compressed=false) {
 const filename=Buffer.from(name),raw=Buffer.from(text),payload=compressed?deflateRawSync(raw):raw;
 let crc=0xffffffff;
 for(const byte of raw){crc^=byte;for(let j=0;j<8;j++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}
 crc=(crc^0xffffffff)>>>0;
 const local=Buffer.alloc(30+filename.length),central=Buffer.alloc(46+filename.length),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(compressed?8:0,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);filename.copy(local,30);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(compressed?8:0,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(filename.length,28);filename.copy(central,46);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length+payload.length,16);
 return Buffer.concat([local,payload,central,end]);
}
