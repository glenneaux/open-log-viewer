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
