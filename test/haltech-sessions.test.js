import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHlg, mergeHlgSessions } from "../web/formats/haltech.js";
function record(type, payload) {
  const b = Buffer.alloc(5 + payload.length);
  b[0] = type;
  b.writeUInt32BE(b.length, 1);
  payload.copy(b, 5);
  return b;
}
function session(ids, values, clock = 1000) {
  const declaration = Buffer.alloc(ids.length * 2);
  ids.forEach((id, i) => declaration.writeUInt16BE(id, i * 2));
  const metadata = Buffer.concat(
    ids.map((id) => {
      const b = Buffer.alloc(11);
      b.writeUInt16BE(1);
      b.writeInt32BE(10000, 7);
      return Buffer.concat([
        b,
        Buffer.from(`RPM${id}\0RPM${id}\0Description\0`),
      ]);
    }),
  );
  const rows = values.map((values, r) => {
    const b = Buffer.alloc(4 + ids.length * 4);
    b.writeUInt32BE(clock + r * 100);
    values.forEach((value, c) => b.writeInt32BE(value, 4 + c * 4));
    return record(7, b);
  });
  return Buffer.concat([
    record(1, Buffer.from("HALTECH1")),
    record(6, declaration),
    record(9, metadata),
    ...rows,
  ]);
}
test("multiple sessions align reordered channels by ID and preserve missing channels", () => {
  const first = session(
      [1, 2],
      [
        [10, 20],
        [11, 21],
      ],
    ),
    second = session(
      [2, 3],
      [
        [22, 30],
        [23, 31],
      ],
      0,
    );
  const merged = parseHlg(Buffer.concat([first, second]));
  assert.deepEqual(
    merged.channels.map((c) => c.channelId),
    [1, 2, 3],
  );
  assert.deepEqual([...merged.data[1]], [20, 21, 22, 23]);
  assert.ok(Number.isNaN(merged.data[0][2]));
  assert.ok(Number.isNaN(merged.data[2][0]));
  assert.ok(Math.abs(merged.time[2] - 0.2) < 1e-10);
  assert.equal(merged.sessions[1].clockAdjusted, true);
});
test("separate HLG streams preserve gaps and ECU error codes", () => {
  const merged = mergeHlgSessions([
    parseHlg(session([1], [[10], [11]])),
    parseHlg(session([1], [[-2147483648], [20]], 2000)),
  ]);
  assert.equal(merged.time[2], 1);
  assert.equal(merged.sessions[1].clockAdjusted, false);
  assert.ok(Number.isNaN(merged.data[0][2]));
  assert.equal(merged.errCodes[0][2], -2147483648);
});
test("rejects inconsistent or truncated declarations instead of mixing channel data", () => {
  assert.throws(() => parseHlg(session([1, 1], [[1, 2]])), /Duplicate/);
  assert.throws(() => parseHlg(session([1], [[1]]).subarray(0, -1)), /length/);
});
