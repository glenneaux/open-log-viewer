import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import readline from "node:readline";
import {
  decryptContainer,
  unzipHlg,
  parseHlg,
} from "../web/formats/haltech.js";
import constants from "../web/formats/haltech-constants.json" with { type: "json" };
test(
  "matches the independent NSP CSV export cell-for-cell",
  { skip: !process.env.HALTECH_TEST_LOG || !process.env.HALTECH_TEST_CSV },
  async () => {
    const archive = await decryptContainer(
      fs.readFileSync(process.env.HALTECH_TEST_LOG),
      constants,
    );
    const entries = await unzipHlg(archive);
    assert.equal(entries.length, 1);
    const parsed = parseHlg(entries[0].data);
    let channel = -1,
      row = 0,
      origin,
      cells = 0;
    for await (const line of readline.createInterface({
      input: fs.createReadStream(process.env.HALTECH_TEST_CSV),
      crlfDelay: Infinity,
    })) {
      if (line.startsWith("Channel : ")) {
        channel++;
        assert.equal(parsed.channels[channel].name, line.slice(10));
      } else if (line.startsWith("Type : "))
        assert.equal(parsed.channels[channel].type, line.slice(7));
      else if (/^\d\d:\d\d:\d\d/.test(line)) {
        const values = line.split(","),
          [h, m, s] = values[0].split(":").map(Number),
          stamp = h * 3600 + m * 60 + s;
        origin ??= stamp;
        assert.ok(
          Math.abs(stamp - origin - parsed.time[row]) < 0.0011,
          `timestamp ${row}`,
        );
        for (let c = 0; c < parsed.channels.length; c++) {
          assert.equal(
            parsed.errCodes[c]?.[row] || parsed.data[c][row],
            Number(values[c + 1]),
            `row ${row}, channel ${c}`,
          );
          cells++;
        }
        row++;
      }
    }
    assert.equal(channel + 1, parsed.channels.length);
    // This NSP export omits the final binary sample; preserve the real record.
    assert.equal(parsed.rows - row, 1);
    assert.equal(cells, 29319498);
  },
);
