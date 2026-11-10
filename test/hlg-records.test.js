import { test } from "node:test";
import assert from "node:assert/strict";
import { readHlgRecords } from "../src/formats/hlg-records.js";
test("walks consecutive records using inclusive lengths", () => {
  const records = [
    ...readHlgRecords(Buffer.from([1, 0, 0, 0, 6, 42, 7, 0, 0, 0, 5])),
  ];
  assert.deepEqual(
    records.map((r) => [r.offset, r.type, r.length]),
    [
      [0, 1, 6],
      [6, 7, 5],
    ],
  );
  assert.equal(records[0].payload[0], 42);
});
test("rejects corrupt framing rather than looping or overreading", () => {
  for (const bytes of [[1], [1, 0, 0, 0, 0], [1, 0, 0, 0, 6]])
    assert.throws(() => [...readHlgRecords(bytes)]);
});
