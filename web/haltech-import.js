// Shared binary loader used by the application's normal multi-file pipeline.
const input = document.getElementById("file-input");
input.accept += ",.hlgzip,.mlg,.ld,.MaxxECU-Zip-log,.MaxxECU-Log";
export async function loadHaltechFile(file) {
  const buffer = await file.arrayBuffer();
  const parsed = await new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./formats/haltech-worker.js", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = ({ data }) => {
      if (data.progress) {
        window.tsUpdateLoading?.(file.name, data.progress);
        return;
      }
      worker.terminate();
      data.error ? reject(Error(data.error)) : resolve(data.parsed);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(Error(e.message));
    };
    worker.postMessage(buffer, [buffer]);
  });
  file.__engineParsed = parsed;
  file.__hlgzipMeta = {
    short_names: Object.fromEntries(
      parsed.channels.map((c) => [c.name, c.shortName]),
    ),
  };
  return parsed;
}
