import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportCsvChunks} from '../web/csv-export.js';
test('exports typed channels, timestamps, missing data and ECU error codes',()=>{
 const log={channels:[{idx:0,name:'RPM',type:'EngineSpeed',min:0,max:10000},{idx:1,name:'Temperature',type:'Temperature'}],time:[0,1.234],data:[[1000,NaN],[2778,NaN]],errCodes:[null,new Int32Array([0,-2147483648])]};
 const csv=[...exportCsvChunks(log,1)].join('');
 assert.match(csv,/Channel : RPM\r\nType : EngineSpeed/);
 assert.match(csv,/00:00:00.000,1000,2778\r\n/);
 assert.match(csv,/00:00:01.234,,-2147483648\r\n/);
 assert.throws(()=>[...exportCsvChunks(null)],/Open a log/);
});
