import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decryptHaltechContainer } from "../src/formats/haltech-container.js";
test("rejects truncated and unrelated files", () => {
  assert.throws(() => decryptHaltechContainer(Buffer.alloc(4)), /truncated/);
  assert.throws(
    () => decryptHaltechContainer(Buffer.alloc(41)),
    /Not a Haltech/,
  );
});
test(
  "decodes external real-world fixture when supplied",
  { skip: !process.env.HALTECH_TEST_LOG },
  () => {
    const result = decryptHaltechContainer(
      readFileSync(process.env.HALTECH_TEST_LOG),
    );
    assert.equal(result.readUInt32LE(0), 0x04034b50);
    assert.ok(
      result.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0,
      "ZIP end record",
    );
  },
);
