// GPL-3.0-only. LD binary layout reference: gotzl/ldparser (GPL-3.0),
// https://github.com/gotzl/ldparser/blob/master/ldparser.py .
// New JavaScript implementation; different-rate channels use sample-and-hold.
const decoder = new TextDecoder();
function half(bits) {
  const sign = bits & 0x8000 ? -1 : 1,
    exponent = (bits >> 10) & 31,
    fraction = bits & 1023;
  return exponent === 31
    ? fraction
      ? NaN
      : sign * Infinity
    : sign *
        (exponent ? 1 + fraction / 1024 : fraction / 1024) *
        2 ** (exponent ? exponent - 15 : -14);
}
export function parseMotec(input) {
  const b = new Uint8Array(input),
    v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const need = (offset, size) => {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      size < 0 ||
      offset + size > b.length
    )
      throw Error("Truncated MoTeC data");
  };
  const str = (offset, size) => {
    need(offset, size);
    return decoder
      .decode(b.subarray(offset, offset + size))
      .split("\0")[0]
      .trim();
  };
  need(0, 94);
  if (v.getUint32(0, true) !== 0x40)
    throw Error("Not a supported MoTeC LD file");
  const fields = [],
    visited = new Set();
  let pointer = v.getUint32(8, true),
    rate = 0,
    duration = 0;
  while (pointer) {
    if (visited.has(pointer)) throw Error("Cyclic MoTeC channel directory");
    visited.add(pointer);
    need(pointer, 84);
    const address = v.getUint32(pointer + 8, true),
      count = v.getUint32(pointer + 12, true),
      kind = v.getUint16(pointer + 18, true),
      width = v.getUint16(pointer + 20, true),
      frequency = v.getUint16(pointer + 22, true),
      shift = v.getInt16(pointer + 24, true),
      multiplier = v.getInt16(pointer + 26, true),
      scale = v.getInt16(pointer + 28, true),
      decimals = v.getInt16(pointer + 30, true);
    if (!frequency || !scale || Math.abs(decimals) > 20)
      throw Error("Invalid MoTeC channel scaling or frequency");
    if (!(
      (kind === 7 && [2, 4].includes(width)) ||
      ([0, 3, 5].includes(kind) && [2, 4].includes(width)) ||
      (kind === 8 && width === 8)
    ))
      throw Error(`Unsupported MoTeC sample type ${kind}/${width}`);
    need(address, count * width);
    fields.push({
      address,
      count,
      kind,
      width,
      frequency,
      shift,
      multiplier,
      scale,
      decimals,
      name: str(pointer + 32, 32) || str(pointer + 64, 8),
      unit: str(pointer + 72, 12),
      id: v.getUint16(pointer + 16, true),
    });
    rate = Math.max(rate, frequency);
    duration = Math.max(duration, count ? (count - 1) / frequency : 0);
    pointer = v.getUint32(pointer + 4, true);
  }
  if (!fields.length) throw Error("No MoTeC channels");
  const rows = Math.floor(duration * rate + 1e-6) + 1;
  if (rows * (fields.length + 1) > 64000000)
    throw Error("MoTeC exceeds the browser sample limit");
  const time = Float64Array.from({ length: rows }, (_, i) => i / rate),
    data = [time];
  for (const f of fields) {
    const out = new Float64Array(rows).fill(NaN);
    for (let r = 0; r < rows; r++) {
      const index = Math.floor((r * f.frequency) / rate + 1e-9);
      if (index >= f.count || time[r] > (f.count - 1) / f.frequency + 1e-9)
        continue;
      const p = f.address + index * f.width;
      let raw =
        f.kind === 7
          ? f.width === 2
            ? half(v.getUint16(p, true))
            : v.getFloat32(p, true)
          : f.kind === 8
            ? v.getFloat64(p, true)
            : f.width === 2
              ? v.getInt16(p, true)
              : v.getInt32(p, true);
      out[r] = ((raw / f.scale) * 10 ** -f.decimals + f.shift) * f.multiplier;
    }
    data.push(out);
  }
  return {
    parsed: {
      channels: [
        { name: "Time (sec)", dp: 6 },
        ...fields.map((f) => ({
          name: f.name,
          dp: Math.max(0, Math.min(9, f.decimals)),
        })),
      ],
      data,
      time,
      rows,
      needsFinish: "motec",
    },
    meta: {
      units: ["s", ...fields.map((f) => f.unit)],
      ids: [0, ...fields.map((f) => f.id)],
      sample_rates: fields.map((f) => f.frequency),
      resampling: "sample-and-hold",
    },
  };
}
