import { unzipEntries } from "./zip.js";
// GPL-3.0-only. Reconstructed HEPS/HLG reader; numeric values remain in ECU
// units so the existing viewer's unit conversion tables apply exactly once.
import verifiedUnits from "./haltech-units.js";
const utf8 = new TextDecoder();
const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
export async function decryptContainer(input, constants) {
  const bytes = new Uint8Array(input),
    v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 41 || utf8.decode(bytes.subarray(0, 5)) !== "HEPS\0")
    throw Error("Not a Haltech HEPS container");
  if (v.getUint32(5, true) !== 16 || (bytes.length - 25) % 16)
    throw Error("Invalid Haltech container length");
  const material = await crypto.subtle.importKey(
    "raw",
    hex(constants.password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: hex(constants.salt),
      iterations: 1000,
      hash: "SHA-1",
    },
    material,
    { name: "AES-CBC", length: 256 },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: bytes.subarray(9, 25) },
      key,
      bytes.subarray(25),
    ),
  );
}
export async function unzipHlg(bytes) { return unzipEntries(bytes, name => /\.hlg$/i.test(name)); }
export function parseHlg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pieces = [];
  let start = 0,
    declared = false;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 5 > bytes.length) throw Error("Truncated HLG record");
    const type = bytes[offset],
      length = view.getUint32(offset + 1);
    if (length < 5 || offset + length > bytes.length)
      throw Error("Invalid HLG record length");
    if (
      offset > start &&
      ((type === 1 && declared) || (type === 6 && declared))
    ) {
      pieces.push(bytes.subarray(start, offset));
      start = offset;
      declared = false;
    }
    if (type === 6) declared = true;
    offset += length;
  }
  pieces.push(bytes.subarray(start));
  const logs = pieces.map(parseHlgSingle);
  return logs.length === 1 ? logs[0] : mergeHlgSessions(logs);
}
function parseHlgSingle(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    records = [];
  let names = [],
    ids = [],
    rows = 0;
  for (let p = 0; p < bytes.length;) {
    if (p + 5 > bytes.length) throw Error("Truncated HLG record");
    const type = bytes[p],
      length = v.getUint32(p + 1);
    if (length < 5 || p + length > bytes.length)
      throw Error("Invalid HLG record length");
    const start = p + 5,
      end = p + length;
    if (type === 6) {
      if (ids.length)
        throw Error("Multiple HLG channel declarations are not yet supported");
      if ((end - start) % 2) throw Error("Invalid HLG channel declaration");
      ids = [];
      for (let q = start; q < end; q += 2) ids.push(v.getUint16(q));
    } else if (type === 9) {
      if (names.length)
        throw Error("Multiple HLG metadata sets are not yet supported");
      names = [];
      let q = start;
      while (q < end) {
        if (q + 11 > end) throw Error("Truncated HLG metadata");
        const unitId = v.getUint16(q),
          flags = bytes[q + 2],
          min = v.getInt32(q + 3),
          max = v.getInt32(q + 7);
        q += 11;
        const text = [];
        for (let i = 0; i < 3; i++) {
          const stop = bytes.indexOf(0, q);
          if (stop < q || stop >= end) throw Error("Unterminated HLG string");
          text.push(utf8.decode(bytes.subarray(q, stop)));
          q = stop + 1;
        }
        names.push({
          name: text[1] || text[0],
          shortName: text[0],
          description: text[2],
          type: verifiedUnits[unitId] || "Other",
          unitId,
          flags,
          min,
          max,
          idx: names.length,
        });
      }
    } else if (type === 7) {
      records.push({ start, end });
      rows++;
    } else if (type !== 1) throw Error("Unsupported HLG record type " + type);
    p = end;
  }
  if (!names.length || names.length !== ids.length)
    throw Error("HLG channel definitions do not match");
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate HLG channel IDs");
  if (names.length * rows > 64000000)
    throw Error("HLG exceeds the browser sample limit");
  names.forEach((channel, index) => {
    channel.channelId = ids[index];
  });
  // This version handles one channel declaration; reject rather than silently
  // misalign channels when a file changes its declaration mid-stream.
  const data = names.map(() => new Float64Array(rows)),
    time = new Float64Array(rows),
    errCodes = names.map(() => null);
  let origin;
  for (let r = 0; r < rows; r++) {
    const { start, end } = records[r];
    if (end - start !== 4 + names.length * 4)
      throw Error("HLG sample width does not match channels");
    const stamp = v.getUint32(start);
    origin ??= stamp;
    time[r] = (stamp - origin) / 1000;
    for (let c = 0; c < names.length; c++) {
      let value = v.getInt32(start + 4 + c * 4);
      if (value >= -2147483648 && value <= -2147483606) {
        errCodes[c] ??= new Int32Array(rows);
        errCodes[c][r] = value;
        value = NaN;
      }
      data[c][r] = value;
    }
  }
  return {
    channels: names,
    time,
    data,
    errCodes,
    rows,
    startTimeMilliseconds: origin ?? 0,
  };
}
export function mergeHlgSessions(logs) {
  if (!logs.length) throw Error("No HLG sessions");
  if (logs.length === 1) return logs[0];
  const channels = [],
    index = new Map(),
    usedNames = new Set();
  let rows = 0;
  const key = (c) => `${c.channelId}:${c.unitId}`;
  for (const log of logs) {
    rows += log.rows;
    for (const c of log.channels) {
      const k = key(c);
      if (index.has(k)) continue;
      let name = c.name;
      if (usedNames.has(name)) {
        let suffix = 2;
        while (usedNames.has(`${name} #${suffix}`)) suffix++;
        name += ` #${suffix}`;
      }
      usedNames.add(name);
      index.set(k, channels.length);
      channels.push({ ...c, name, idx: channels.length });
    }
  }
  if (rows * channels.length > 64000000)
    throw Error("Merged HLG exceeds the browser sample limit");
  const time = new Float64Array(rows),
    data = channels.map(() => new Float64Array(rows).fill(NaN)),
    errCodes = channels.map(() => null),
    sessions = [];
  const origin = logs[0].startTimeMilliseconds;
  let cursor = 0;
  for (const log of logs) {
    if (!log.rows) continue;
    let offset = (log.startTimeMilliseconds - origin) / 1000,
      adjusted = false;
    if (cursor && offset + log.time[0] <= time[cursor - 1]) {
      let step = 0.001;
      for (let r = 1; r < log.rows; r++) {
        const delta = log.time[r] - log.time[r - 1];
        if (delta > 0) {
          step = delta;
          break;
        }
      }
      offset = time[cursor - 1] + step - log.time[0];
      adjusted = true;
    }
    sessions.push({
      startRow: cursor,
      rows: log.rows,
      offsetSeconds: offset,
      clockAdjusted: adjusted,
    });
    for (let r = 0; r < log.rows; r++) time[cursor + r] = log.time[r] + offset;
    for (let c = 0; c < log.channels.length; c++) {
      const target = index.get(key(log.channels[c]));
      data[target].set(log.data[c], cursor);
      if (log.errCodes[c]) {
        errCodes[target] ??= new Int32Array(rows);
        errCodes[target].set(log.errCodes[c], cursor);
      }
    }
    cursor += log.rows;
  }
  return {
    channels,
    time,
    data,
    errCodes,
    rows,
    startTimeMilliseconds: origin,
    sessions,
  };
}
