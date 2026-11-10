import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMlg} from '../web/formats/mlg.js';
function fixture(){
 const b=Buffer.alloc(24+89+14);b.write('MLVLG');b.writeUInt16BE(2,6);b.writeUInt32BE(113,16);b.writeUInt16BE(2,20);b.writeUInt16BE(1,22);
 b[24]=3;b.write('Temperature',25);b.write('C',59);b.writeFloatBE(0.5,70);b.writeFloatBE(-10,74);b[78]=1;
 for(let i=0;i<2;i++){let p=113+i*7;b[p+1]=i;b.writeUInt16BE(i?200:65500,p+2);b.writeInt16BE(i?-20:40,p+4);b[p+6]=(b[p+4]+b[p+5])&255;}return b;
}
test('MLG v2 applies transforms, signed values and timestamp wrap',()=>{
 const {parsed,meta}=parseMlg(fixture());assert.deepEqual(Array.from(parsed.data[1]),[15,-15]);assert.ok(Math.abs(parsed.time[1]-.00236)<1e-9);assert.equal(meta.units[1],'C');
});
test('MLG rejects bad checksums and truncated records',()=>{
 const b=fixture();b[119]^=1;const r=parseMlg(b);assert.equal(r.parsed.rows,1);assert.equal(r.meta.rejected_checksum,1);assert.throws(()=>parseMlg(fixture().subarray(0,126)),/Truncated/);
});
test('MLG v1 reads its shorter header and descriptors',()=>{
 const original=fixture(),b=Buffer.alloc(22+55+14);
 original.copy(b,0,0,22);b.writeUInt16BE(1,6);b.writeUInt32BE(77,14);b.writeUInt16BE(2,18);b.writeUInt16BE(1,20);
 original.copy(b,22,24,79);original.copy(b,77,113);
 const {parsed,meta}=parseMlg(b);assert.equal(meta.version,1);assert.deepEqual([...parsed.data[1]],[15,-15]);
});
function bitFixture(){
 const names=Buffer.from('Running\0INVALID\0Warning\0'),start=113+names.length,b=Buffer.alloc(start+6);
 b.write('MLVLG');b.writeUInt16BE(2,6);b.writeUInt32BE(start,16);b.writeUInt16BE(1,20);b.writeUInt16BE(1,22);
 b[24]=10;b.writeUInt32BE(113,71);b[75]=3;names.copy(b,113);b[start+4]=5;b[start+5]=5;return b;
}
test('MLG expands named bits, skips INVALID and hides unnamed parent',()=>{
 const {parsed}=parseMlg(bitFixture());assert.deepEqual(parsed.channels.map(c=>c.name),['Time (sec)','Running','Warning']);
 assert.deepEqual(parsed.data.map(c=>[...c]),[[0],[1],[1]]);
});
test('MLG rejects out-of-bounds bit labels and impossible bit counts',()=>{
 const b=bitFixture();b.writeUInt32BE(b.length,71);assert.throws(()=>parseMlg(b),/bit-name/);
 b[75]=9;assert.throws(()=>parseMlg(b),/bit count/);
});
test('MLG zero-time markers do not introduce a false clock rollover',()=>{
 const original=fixture(),b=Buffer.concat([original.subarray(0,120),Buffer.alloc(54),original.subarray(120)]);
 b[120]=1;b.write('Note',124);const {parsed,meta}=parseMlg(b);
 assert.ok(Math.abs(parsed.time[1]-.00236)<1e-9);assert.equal(meta.markers[0].t,parsed.time[1]);
});
