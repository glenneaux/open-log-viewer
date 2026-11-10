import { unzipEntries } from './zip.js';

// Container extraction only. The recovered frontend interprets MaxxECU TSV
// headers, units and sample timing. Binary maxxlog and tune metadata are separate.
export async function unpackMaxxecu(input) {
  const entries = await unzipEntries(new Uint8Array(input),
    name => /\.(MaxxECU-Log|maxxlog)$/i.test(name));
  const logs = entries.filter(entry => /\.MaxxECU-Log$/i.test(entry.name));
  if (!logs.length) throw Error('This MaxxECU package contains binary .maxxlog data; binary decoding is not implemented yet');
  if (logs.length !== 1) throw Error('Multiple MaxxECU text streams are not supported yet');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(logs[0].data);
  if (text.includes('\0') || !text.split(/\r?\n/, 1)[0].includes('\t'))
    throw Error('MaxxECU text stream must have a tab-separated header');
  return { text, meta: { source_member: logs[0].name, container_metadata_applied: false } };
}
