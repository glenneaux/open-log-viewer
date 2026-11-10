// Bounded ZIP reader shared by native containers.
const utf8 = new TextDecoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export async function unzipEntries(bytes, accept = () => true) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (v.getUint32(p, true) === 0x06054b50) {
      end = p;
      break;
    }
  if (end < 0) throw Error("ZIP directory missing");
  if (end + 22 + v.getUint16(end + 20, true) !== bytes.length)
    throw Error('Invalid ZIP end record');
  if (v.getUint16(end + 4, true) || v.getUint16(end + 6, true) ||
      v.getUint16(end + 8, true) !== v.getUint16(end + 10, true))
    throw Error('Multi-disk ZIP is unsupported');
  let p = v.getUint32(end + 16, true);
  const entries = [];
  let totalExpanded = 0;
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
    if (p + 46 + n + extra + comment > end) throw Error('Truncated ZIP directory');
    const flags = v.getUint16(p + 8, true);
    p += 46 + n + extra + comment;
    if (!accept(name)) continue;
    if (flags & 1) throw Error('Encrypted ZIP members are unsupported');
    totalExpanded += expanded;
    if (totalExpanded > 512 * 1024 * 1024)
      throw Error(
        "Selected ZIP members exceed the 512 MB browser decoder limit",
      );
    if (expanded > 512 * 1024 * 1024)
      throw Error("ZIP member exceeds the 512 MB browser decoder limit");
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
  if (!entries.length) throw Error("No matching stream in this container");
  return entries;
}
