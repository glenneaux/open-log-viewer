import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unpackMaxxecu} from '../web/formats/maxxecu.js';
import {zipFixture} from './zip-fixture.js';
const text='Time (s)\tRPM\n0\t1000\n1\t2000\n';
test('MaxxECU extracts stored and deflated text streams without inventing metadata',async()=>{
 for(const compressed of [false,true]){
  const result=await unpackMaxxecu(zipFixture('folder/example.MaxxECU-Log',text,compressed));
  assert.equal(result.text,text);assert.equal(result.meta.container_metadata_applied,false);assert.equal(result.meta.log_rate,undefined);
 }
});
test('MaxxECU rejects binary-only packages and malformed text',async()=>{
 await assert.rejects(unpackMaxxecu(zipFixture('example.maxxlog','binary')),/binary decoding/);
 await assert.rejects(unpackMaxxecu(zipFixture('example.MaxxECU-Log','bad')),/tab-separated/);
});
test('ZIP rejects corruption, encryption and truncation',async()=>{
 const b=zipFixture('example.MaxxECU-Log',text);b[30+'example.MaxxECU-Log'.length]^=1;
 await assert.rejects(unpackMaxxecu(b),/CRC/);
 const encrypted=zipFixture('example.MaxxECU-Log',text);encrypted[encrypted.readUInt32LE(encrypted.length-6)+8]=1;
 await assert.rejects(unpackMaxxecu(encrypted),/Encrypted/);
 await assert.rejects(unpackMaxxecu(b.subarray(0,-3)),/ZIP/);
});
