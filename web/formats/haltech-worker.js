import { decryptContainer, unzipHlg, parseHlg } from "./haltech.js";
self.onmessage = async ({ data }) => {
  try {
    const constants = await (await fetch("./haltech-constants.json")).json();
    self.postMessage({ progress: "Decrypting Haltech container…" });
    const archive = await decryptContainer(data, constants);
    self.postMessage({ progress: "Expanding HLG records…" });
    const entries = await unzipHlg(archive);
    if (entries.length !== 1)
      throw Error(
        "Multiple HLG streams require session merging, which is not yet implemented",
      );
    self.postMessage({ progress: "Decoding channels and samples…" });
    const parsed = parseHlg(entries[0].data);
    const transfers = [
      parsed.time.buffer,
      ...parsed.data.map((a) => a.buffer),
      ...parsed.errCodes.filter(Boolean).map((a) => a.buffer),
    ];
    self.postMessage({ parsed }, transfers);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
