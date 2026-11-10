// GPL-3.0-only. Reconstructed HEPS/HLG reader; numeric values remain in ECU
// units so the existing viewer's unit conversion tables apply exactly once.
import verifiedUnits from "./haltech-units.js";
const utf8 = new TextDecoder();
const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
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
export async function unzipHlg(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (v.getUint32(p, true) === 0x06054b50) {
      end = p;
      break;
    }
  if (end < 0) throw Error("ZIP directory missing");
  let p = v.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50)
      throw Error("Corrupt ZIP directory");
    const crc = v.getUint32(p + 16, true),
      method = v.getUint16(p + 10, true),
      size = v.getUint32(p + 20, true),
      expanded = v.getUint32(p + 24, true),
      n = v.getUint16(p + 28, true),
      extra = v.getUint16(p + 30, true),
      comment = v.getUint16(p + 32, true),
      local = v.getUint32(p + 42, true),
      name = utf8.decode(bytes.subarray(p + 46, p + 46 + n));
    p += 46 + n + extra + comment;
    if (!/\.hlg$/i.test(name)) continue;
    if (expanded > 512 * 1024 * 1024)
      throw Error("HLG exceeds the 512 MB browser decoder limit");
    if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50)
      throw Error("Corrupt ZIP member");
    const start =
      local +
      30 +
      v.getUint16(local + 26, true) +
      v.getUint16(local + 28, true);
    if (start + size > bytes.length) throw Error("Truncated ZIP member");
    let data = bytes.subarray(start, start + size);
    if (method === 8) {
      const reader = new Blob([data])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"))
          .getReader(),
        chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > expanded) {
          await reader.cancel();
          throw Error("ZIP expands beyond its declared size");
        }
        chunks.push(value);
      }
      data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    } else if (method !== 0)
      throw Error("Unsupported ZIP compression method " + method);
    if (data.length !== expanded) throw Error("ZIP expanded length mismatch");
    if (crc32(data) !== crc) throw Error("ZIP member CRC mismatch");
    entries.push({ name, data });
  }
  if (!entries.length) throw Error("No HLG stream in this container");
  return entries;
}
export function parseHlg(bytes) {
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
  return { channels: names, time, data, errCodes, rows };
}
