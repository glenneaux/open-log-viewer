import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMotec } from "../web/formats/motec.js";
function fixture() {
  const b = Buffer.alloc(400);
  b.writeUInt32LE(0x40, 0);
  b.writeUInt32LE(100, 8);
  for (let i = 0; i < 2; i++) {
    const p = 100 + i * 100;
    b.writeUInt32LE(i ? 0 : 200, p + 4);
    b.writeUInt32LE(320 + i * 20, p + 8);
    b.writeUInt32LE(i ? 2 : 3, p + 12);
    b.writeUInt16LE(3, p + 18);
    b.writeUInt16LE(2, p + 20);
    b.writeUInt16LE(i ? 1 : 2, p + 22);
    b.writeInt16LE(1, p + 24);
    b.writeInt16LE(2, p + 26);
    b.writeInt16LE(10, p + 28);
    b.write(`Channel${i}`, p + 32);
    b.write("V", p + 72);
  }
  [-20, 0, 20].forEach((x, i) => b.writeInt16LE(x, 320 + i * 2));
  [100, 200].forEach((x, i) => b.writeInt16LE(x, 340 + i * 2));
  return b;
}
test("MoTeC decodes scaling and merges multiple sample rates", () => {
  const { parsed, meta } = parseMotec(fixture());
  assert.deepEqual([...parsed.time], [0, 0.5, 1]);
  assert.deepEqual([...parsed.data[1]], [-2, 2, 6]);
  assert.deepEqual([...parsed.data[2]], [22, 22, 42]);
  assert.deepEqual(meta.sample_rates, [2, 1]);
});
test("MoTeC rejects cycles, truncation and unsupported sample types", () => {
  const b = fixture();
  b.writeUInt32LE(100, 204);
  assert.throws(() => parseMotec(b), /Cyclic/);
  assert.throws(() => parseMotec(fixture().subarray(0, 200)), /Truncated/);
  b.writeUInt32LE(0, 204);
  b.writeUInt16LE(99, 118);
  assert.throws(() => parseMotec(b), /Unsupported/);
});
