// Tauri desktop bridge.
//
// No-op when index.html is opened directly in a plain browser (handy for
// quick UI debugging). When running inside the Tauri shell, this:
//   - intercepts "Load Log" / "Load Compare" so they use the native file
//     dialog (defaulted to the user's Documents folder) instead of the
//     browser's hidden <input type=file>
//   - opens any file passed on the CLI (e.g. ts-log-viewer.exe C:\logs\a.csv)
//     or forwarded from a second instance / drag-onto-exe
//   - accepts files dropped onto the window
//
// Native-opened files are funnelled back through the existing <input> change
// handlers by synthesising a File object — the parsing/state code stays
// untouched.

(function () {
  if (!window.__TAURI_INTERNALS__) return; // browser build: do nothing

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const dialog = window.__TAURI__.dialog;
  const path = window.__TAURI__.path;

  let lastDir = null; // remember last-used directory across opens

  async function defaultOpenDir() {
    if (lastDir) return lastDir;
    try {
      return await path.documentDir();
    } catch {
      return undefined;
    }
  }

  function basename(p) {
    return String(p).split(/[\\/]/).pop() || p;
  }

  function dirname(p) {
    const s = String(p);
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(0, i) : s;
  }

  // Read one or more files via Rust and inject them into the given
  // <input type=file>, then fire a single 'change' so the existing CSV
  // pipeline handles them.
  //
  // Uses each file's real size + mtime so the page's metadataKey
  // (filename|size|lastModified) is stable across launches — otherwise
  // saved log metadata wouldn't survive a reload.
  // Ring buffer of the most recent log-load debug transcripts — one per
  // file, whatever its format and whichever way it came in (this dialog, a
  // reopen by path, a set archive, the parsed-log cache) — keyed by log
  // filename. Surfaced by Tools -> "Log load debug…". Every decoder in the host
  // times its stages into `info.debug`; this is where those lines are kept
  // rather than scrolled off the console.
  const _loadTranscripts = [];
  function _pushLoadTranscript(entry) {
    const lines = Array.isArray(entry.lines) ? entry.lines : [];
    for (const ln of lines) console.log(ln);
    _loadTranscripts.push({ ts: Date.now(), ...entry, lines });
    if (_loadTranscripts.length > 12) _loadTranscripts.shift();
  }
  window.__tsLoadTranscripts = _loadTranscripts;
  // The app's reopen / restore paths (readLogSource, the parsed-log cache)
  // decode without coming through this file, so they push their own.
  window.__tsPushLoadTranscript = _pushLoadTranscript;

  // Let the app append its own timing lines (the frontend parse, the overlay
  // registration) to the transcript for the log it just handled, so the
  // dialog shows the complete picture: decode -> transfer -> parse.
  window.__tsNoteLoadTiming = function (name, line) {
    for (let i = _loadTranscripts.length - 1; i >= 0; i--) {
      const t = _loadTranscripts[i];
      if (t.name === name) {
        t.lines.push(line);
        console.log(line);
        return;
      }
    }
    console.log(line);
  };

  // Surface files the Rust side refused to read. The messages coming back are
  // already specific ("no .MaxxECU-Log or .maxxlog member inside the zip
  // (found: …)"), so they are shown verbatim rather than flattened into a
  // generic "couldn't open that".
  function reportReadFailures(failures, total) {
    if (!failures.length) return;
    const toast = window.showToast;
    const first = `${failures[0].name}: ${failures[0].reason}`;
    const msg =
      failures.length === 1
        ? `Couldn't open ${first}`
        : `Couldn't open ${failures.length} of ${total} logs: ${first}`;
    if (typeof toast === "function") toast(msg, "error");
    else console.error(msg);
  }

  async function feedFiles(inputId, filePaths) {
    const input = document.getElementById(inputId);
    if (!input || !filePaths || !filePaths.length) return;
    // Reading each file's contents from disk (below) happens before the
    // 'change' event fires, so index.html's own showLoadingOverlay() call
    // (inside its change handler) doesn't run until all reads are already
    // done. For multiple/large files that read loop is what makes the app
    // look unresponsive — show the overlay here so it appears immediately.
    const n = filePaths.length;
    if (window.tsShowLoading) {
      window.tsShowLoading(
        n > 1
          ? `Reading ${n} logs from disk…`
          : `Reading ${basename(filePaths[0])}…`,
        n > 1 ? "" : "Opening file…",
      );
    }
    // Opening a log is two passes over the same files: this one reads and
    // decodes each, then loadFilesIntoApp parses each. One progress session
    // spans both — this loop claims the first half of the bar and the parse
    // pass continues from where it left off, rather than each filling the bar
    // from empty. Ended by tsHideLoading, whichever pass gets there.
    const prog = window.tsLoadProgress;
    if (prog) {
      prog.begin();
      prog.span(0, 0.5, n);
    }
    const dt = new DataTransfer();
    const paths = [];
    const failures = [];
    let readCount = 0;
    for (const filePath of filePaths) {
      readCount++;
      // Headline names which file of how many; the detail line below is
      // advanced again once we know whether this is a plain CSV read or a
      // .hlgzip that has to be decrypted and decoded (seconds, not
      // milliseconds — see the HLGZIP load performance notes in CLAUDE.md).
      const label =
        n > 1
          ? `Reading log ${readCount} of ${n}: ${basename(filePath)}`
          : `Reading ${basename(filePath)}…`;
      if (prog) prog.unit(readCount - 1);
      if (window.tsUpdateLoading)
        window.tsUpdateLoading(label, "Opening file…");
      try {
        // Sidecar upgrade: if the user picked / NSP handed off a `.csv`
        // and a same-basename `.hlgzip` is present next to it, prefer
        // the .hlgzip for the richer ECU-id + enum data.
        let effectivePath = filePath;
        let isHlgzip = false;
        let isMaxxecu = false;
        let isLlgx = false;
        let isMotec = false;
        let isSuperflow = false;
        let isEmtron = false;
        let isMlg = false;
        let upgraded = false;
        try {
          const resolved = await invoke("resolve_log_source", {
            path: filePath,
          });
          effectivePath = resolved.path || filePath;
          isHlgzip = !!resolved.is_hlgzip;
          isMaxxecu = !!resolved.is_maxxecu;
          isLlgx = !!resolved.is_llgx;
          isMotec = !!resolved.is_motec;
          isSuperflow = !!resolved.is_superflow;
          isEmtron = !!resolved.is_emtron;
          isMlg = !!resolved.is_mlg;
          upgraded = !!resolved.upgraded;
        } catch (e) {
          console.error("resolve_log_source failed", e);
        }

        let info;
        let hlgzipMeta = null;
        let maxxMeta = null;
        let llgxMeta = null;
        let motecMeta = null;
        let superflowMeta = null;
        let emtronMeta = null;
        let mlgMeta = null;
        let engineParsed = null;
        // The transfer happens before this log's debug transcript is
        // assembled, so its timing line waits here rather than being pushed to
        // a transcript that doesn't exist yet.
        const engineTiming = [];
        // One read of the engine rule for every format branch below. The rule
        // itself lives in the app (window.tsEngine), not here: two readers of
        // one flag drift, and this one would drift silently.
        const engine = window.tsEngine;
        const engineOn = !!engine && engine.enabled();
        // Round-trip clock and the command it timed, for the transcript every
        // branch below leaves behind. Timed separately from the Rust-side
        // stage timings in info.debug: the decode is only part of the wait,
        // the payload (or the synthesised text) also has to cross the Tauri
        // IPC bridge — and on the text path be re-materialised as a JS string.
        const _t0 = performance.now();
        let loadCmd = "read_log_file_with_stat";
        let fmtLabel = "text";
        if (isSuperflow) {
          // A .ptd / .ptda is a SuperFlow dyno test: gzip-wrapped JSON with
          // every channel's samples inside it. The Rust side inflates and
          // decodes it into the same tab-separated table Link and MoTeC use
          // (`Time (sec)` column, blank cells for non-finite readings) and
          // returns the test identity / timebase mode / per-column units
          // alongside. Engine path: the same raw-scan payload + frontend
          // finishing as the two below, so the unit fold and the index
          // timebase for a .ptda never move out of the frontend.
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(label, "Decoding SuperFlow dyno log…");
          }
          loadCmd = engineOn ? "load_superflow_columns" : "load_superflow_file";
          fmtLabel = "SuperFlow";
          info = await invoke(
            engineOn ? "load_superflow_columns" : "load_superflow_file",
            { path: effectivePath },
          );
          superflowMeta = info.superflow_meta || null;
          if (engineOn) {
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
              },
              (line) => engineTiming.push(line),
              Infinity,
            );
            engineParsed.needsFinish = "superflow";
          }
        } else if (isMlg) {
          // An .mlg is TunerStudio's binary datalog (MegaSquirt, Speeduino,
          // rusEFI). The Rust side reads the field table and records and
          // returns the same tab-separated table Link / MoTeC use, plus a
          // sidecar with the units / precision / timebase / markers;
          // parseMlgCSV finishes it. Engine path: the same raw-scan payload +
          // frontend finishing as Link below.
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(label, "Decoding MLG log…");
          }
          loadCmd = engineOn ? "load_mlg_columns" : "load_mlg_file";
          fmtLabel = "MLG";
          info = await invoke(engineOn ? "load_mlg_columns" : "load_mlg_file", {
            path: effectivePath,
          });
          mlgMeta = info.mlg_meta || null;
          if (engineOn) {
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
              },
              (line) => engineTiming.push(line),
              Infinity,
            );
            engineParsed.needsFinish = "mlg";
          }
        } else if (isEmtron) {
          // An .elf is an Emtron log: a ZipCrypto-encrypted, deflated zip
          // around a CSV whose header names channels by numeric parameter
          // id. The Rust side decrypts + inflates it and returns the CSV plus
          // the second line's metadata (start date/time, calibration .ecf
          // name); parseEmtronCSV maps ids to names/units. Engine path: the
          // CSV scanned in Rust (emtron::scan, the twin of _emtronScan) and
          // finished by the same parseEmtronCSV.
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(label, "Decrypting EMtron log…");
          }
          loadCmd = engineOn ? "load_emtron_columns" : "load_emtron_file";
          fmtLabel = "EMtron";
          info = await invoke(
            engineOn ? "load_emtron_columns" : "load_emtron_file",
            { path: effectivePath },
          );
          emtronMeta = info.emtron_meta || null;
          if (engineOn) {
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
              },
              (line) => engineTiming.push(line),
              Infinity,
            );
            engineParsed.needsFinish = "emtron";
          }
        } else if (isMotec) {
          // A .ld is MoTeC i2 Pro's binary datalog; the Rust side walks the
          // channel-metadata linked list and merges each channel's samples
          // (each at its own rate) into one tab-separated table with a
          // `Time (sec)` column, returning the device / driver / venue /
          // per-column-units metadata alongside. Engine path: the same
          // raw-scan payload + frontend finishing as Link below, so the unit
          // fold and the timebase never move out of the frontend.
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(label, "Decoding MoTeC .ld…");
          }
          loadCmd = engineOn ? "load_motec_columns" : "load_motec_file";
          fmtLabel = "MoTeC";
          info = await invoke(
            engineOn ? "load_motec_columns" : "load_motec_file",
            { path: effectivePath },
          );
          motecMeta = info.motec_meta || null;
          if (engineOn) {
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
              },
              (line) => engineTiming.push(line),
              Infinity,
            );
            engineParsed.needsFinish = "motec";
          }
        } else if (isLlgx) {
          // A .llgx / .llg / .llg5 is Link's binary stream container; the Rust side
          // merges the per-channel streams into one tab-separated table and
          // returns the device identity / units / delta-log flag alongside.
          // On the engine path the table crosses as a binary column payload —
          // the raw scan — and the app runs its real parseLinkCSV finishing
          // over it (`needsFinish`), so units and the delta-log fill never
          // move out of the frontend.
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(label, "Decoding Link log…");
          }
          loadCmd = engineOn ? "load_llgx_columns" : "load_llgx_file";
          fmtLabel = "Link";
          info = await invoke(
            engineOn ? "load_llgx_columns" : "load_llgx_file",
            { path: effectivePath },
          );
          llgxMeta = info.link_meta || null;
          if (engineOn) {
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
              },
              (line) => engineTiming.push(line),
              Infinity,
            );
            engineParsed.needsFinish = "link";
          }
        } else if (isMaxxecu) {
          // A .MaxxECU-Zip-log is a zip; the Rust side unpacks it and returns the
          // inner tab-separated log plus the sample rate and tune-derived unit
          // table the log text itself doesn't carry. Engine path: same raw-scan
          // payload + frontend finishing as Link above.
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(label, "Unpacking MaxxECU log package…");
          }
          loadCmd = engineOn ? "load_maxxecu_columns" : "load_maxxecu_file";
          fmtLabel = "MaxxECU";
          info = await invoke(
            engineOn ? "load_maxxecu_columns" : "load_maxxecu_file",
            { path: effectivePath },
          );
          maxxMeta = info.maxx_meta || null;
          if (engineOn) {
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
              },
              (line) => engineTiming.push(line),
              Infinity,
            );
            engineParsed.needsFinish = "maxxecu";
          }
        } else if (isHlgzip) {
          if (window.tsUpdateLoading) {
            window.tsUpdateLoading(
              label,
              "Decrypting Haltech container and reading ECU definitions…",
            );
          }
          // Engine column path, now the default (opt out per device with
          // localStorage.tslv_engine = "0"). The decode pipeline is the same;
          // what changes is how the samples cross the bridge — one raw binary
          // payload read in ranges instead of tens of MB of CSV text
          // serialised into the JSON reply and re-parsed on the other side.
          fmtLabel = "Haltech";
          if (engineOn) {
            loadCmd = "load_hlgzip_columns";
            info = await invoke("load_hlgzip_columns", { path: effectivePath });
            // Transferred here, in the step that created it, rather than
            // handed on to the parse pass as a payload id. This loop runs over
            // every file before the app parses any of them, so parking one
            // payload per file meant a five-log open holding five gigabyte
            // buffers in Rust at once — and the store's cap dropping the
            // earliest of them before its turn came, failing that log's open
            // with a range error. One payload is alive at a time now, by
            // construction rather than by a cap chosen to be big enough.
            //
            // Ranged within that: Chromium caps a single ArrayBuffer between
            // 1.5 and 2 GB, and a large log's payload is over 1 GB — at the
            // wall already, and out of reach for anything bigger.
            engineParsed = await engine.transfer(
              invoke,
              info.engine_log_id,
              info.engine_payload_len,
              (doneBytes, totalBytes) => {
                if (prog && totalBytes > 0)
                  prog.fraction(doneBytes / totalBytes);
                // The percentage is the overlay bar's job — one place formats
                // it, for every path that reports a fraction — so this line
                // only has to say what is being transferred.
                if (window.tsUpdateLoading) {
                  window.tsUpdateLoading(
                    label,
                    `Transferring ${(totalBytes / 1048576).toFixed(0)} MB of channel data\u2026`,
                  );
                }
              },
              (line) => engineTiming.push(line),
            );
          } else {
            loadCmd = "load_hlgzip_file";
            info = await invoke("load_hlgzip_file", { path: effectivePath });
          }
          hlgzipMeta = {
            ecu_family: info.ecu_family,
            ecu_family_detail: info.ecu_family_detail,
            definition: info.definition,
            hdef_path: info.hdef_path,
            hdef_version: info.hdef_version,
            hdef_substitute: info.hdef_substitute || "",
            enum_overlay: info.enum_overlay,
            bitfield_names: info.bitfield_names,
            short_names: info.short_names,
            // ECU-map plumbing: the table catalogue extracted from the
            // .hdef and the decrypted .nexmap _map signal values (hex
            // strings). Any of these may be empty on unrecognised
            // firmware — the frontend handles that gracefully. The raw
            // tune-snapshot bytes the reply also carries are deliberately
            // NOT forwarded: nothing reads them since Tune Assist went.
            tables: info.tables || {},
            nexmap_signals: info.nexmap_signals || {},
            hdef_channel_names: info.hdef_channel_names || {},
            logged_channel_names: info.logged_channel_names || {},
            hdef_channel_units: info.hdef_channel_units || {},
            // MD5 of the map password when the .nexmap is locked in NSP. A
            // locked map's signal values above arrive EMPTY until the app
            // has verified the password once on this device.
            map_lock_md5: info.map_lock_md5 || "",
            // The vehicle name the map's own metadata carries, for the
            // "detect vehicle name" option in the metadata popup.
            map_vehicle: info.map_vehicle || "",
          };
        } else {
          if (window.tsUpdateLoading)
            window.tsUpdateLoading(label, "Reading CSV from disk…");
          info = await invoke("read_log_file_with_stat", {
            path: effectivePath,
          });
        }
        // The transcript, for every format alike: the decoder's own stage
        // lines, the read-and-decode total, then (column path) the transfer + decode
        // breakdown of that round trip. A plain CSV has no decoder lines; it
        // still gets a transcript so the app's parse timing has somewhere to
        // land.
        {
          const _ipcMs = performance.now() - _t0;
          const lines = Array.isArray(info.debug) ? info.debug.slice() : [];
          if (engineParsed) {
            const _payloadMb = (
              (info.engine_payload_len || 0) / 1048576
            ).toFixed(1);
            lines.push(
              `[load] read and decode: ${_ipcMs.toFixed(0)} ms ` +
                `(${_payloadMb} MB of channel data)`,
            );
          } else {
            const _txtMb = ((info.text || "").length / 1048576).toFixed(1);
            lines.push(
              `[load] ${fmtLabel === "text" ? "read" : "read and decode"}: ${_ipcMs.toFixed(0)} ms ` +
                `(${_txtMb} MB of text)`,
            );
          }
          lines.push(...engineTiming.splice(0));
          if (upgraded)
            lines.unshift(
              `[load] opened '${effectivePath}' instead of '${filePath}' (matching log found alongside it)`,
            );
          _pushLoadTranscript({
            name: info.name || effectivePath,
            path: effectivePath,
            origPath: filePath,
            format: fmtLabel,
            via: "open",
            upgraded,
            lines,
          });
        }
        const file = new File([info.text], info.name, {
          lastModified: info.last_modified || Date.now(),
        });
        // Reflect the filesystem size, not the JS string length, so the key
        // matches what the browser build would produce for the same file.
        try {
          Object.defineProperty(file, "size", { value: info.size });
        } catch {}
        if (hlgzipMeta) {
          try {
            Object.defineProperty(file, "__hlgzipMeta", { value: hlgzipMeta });
          } catch {
            file.__hlgzipMeta = hlgzipMeta;
          }
        }
        if (engineParsed) {
          // The decoded record rides the synthesised File as a property (the
          // File's content is empty on this path); loadFilesIntoApp branches
          // on it. Everything else — batching, ordering, per-file error
          // handling, __hlgzipMeta, the size/mtime that key saved metadata —
          // flows through the one existing pipeline unchanged.
          try {
            Object.defineProperty(file, "__engineParsed", {
              value: engineParsed,
            });
          } catch {
            file.__engineParsed = engineParsed;
          }
        }
        if (maxxMeta) {
          try {
            Object.defineProperty(file, "__maxxMeta", { value: maxxMeta });
          } catch {
            file.__maxxMeta = maxxMeta;
          }
        }
        if (llgxMeta) {
          try {
            Object.defineProperty(file, "__llgxMeta", { value: llgxMeta });
          } catch {
            file.__llgxMeta = llgxMeta;
          }
        }
        if (motecMeta) {
          try {
            Object.defineProperty(file, "__motecMeta", { value: motecMeta });
          } catch {
            file.__motecMeta = motecMeta;
          }
        }
        if (superflowMeta) {
          try {
            Object.defineProperty(file, "__superflowMeta", {
              value: superflowMeta,
            });
          } catch {
            file.__superflowMeta = superflowMeta;
          }
        }
        if (emtronMeta) {
          try {
            Object.defineProperty(file, "__emtronMeta", { value: emtronMeta });
          } catch {
            file.__emtronMeta = emtronMeta;
          }
        }
        if (mlgMeta) {
          try {
            Object.defineProperty(file, "__mlgMeta", { value: mlgMeta });
          } catch {
            file.__mlgMeta = mlgMeta;
          }
        }
        dt.items.add(file);
        paths.push(filePath);
      } catch (err) {
        // A read/decode failure here never reaches index.html — this file is
        // simply left out of the DataTransfer, and if it was the only one no
        // 'change' event fires at all, so the app would appear to shrug the
        // open off entirely. Collect it and report below.
        console.error("Failed to read", filePath, err);
        failures.push({
          name: basename(filePath),
          reason: (err && (err.message || err.toString())) || "unknown error",
        });
      }
    }
    reportReadFailures(failures, filePaths.length);
    if (!dt.files.length) {
      // No 'change' event will fire to trigger index.html's own
      // hideLoadingOverlay(), so clear the overlay we opened above.
      if (window.tsHideLoading) window.tsHideLoading();
      return;
    }
    input.files = dt.files;
    // Hand the real filesystem paths to addLog (aligned to input.files order)
    // so the session can be restored on the next launch.
    window.__tsOpenPaths = paths;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    lastDir = dirname(paths[paths.length - 1]);
  }

  // Single-file convenience used by the CLI / drag / NSP hand-off paths.
  async function feedInput(inputId, filePath) {
    return feedFiles(inputId, [filePath]);
  }

  async function pickAndOpen(inputId, title) {
    const selected = await dialog.open({
      title,
      multiple: true,
      directory: false,
      defaultPath: await defaultOpenDir(),
      // Keep in step with MAXXECU_EXTENSIONS in src-tauri/src/maxxecu.rs,
      // LLGX_EXTENSIONS in src-tauri/src/llgx.rs, MOTEC_EXTENSIONS in
      // src-tauri/src/motec.rs and SUPERFLOW_EXTENSIONS in src-tauri/src/superflow.rs.
      // MTune's container is `.MaxxECU-Zip-log`; `.MaxxECU-Log` (text) and
      // `.maxxlog` (LZ4 binary) are its two possible inner log members, and
      // the undashed container spelling is a tolerated variant. `.llgx`
      // (G4X-era PCLink), `.llg` (G4+-era) and `.llg5` (G5-era) are the same
      // Link log container under three extensions (both PC and ECU internal
      // datalogs). `.ld` is MoTeC i2 Pro's binary datalog; the `.ldx`
      // beacon/lap sidecar is XML and is not a log on its own. `.ptd` is a
      // SuperFlow dyno test's time-series recording and `.ptda` its
      // speed-bucketed analysis; each is a complete file on its own.
      //
      // `.msl`, `.txt`, `.tsv` and `.log` are not formats of their own: they
      // are the spellings other tools give a delimited text export, and the
      // generic parser already reads that shape. `.msl` is TunerStudio's
      // (so MegaSquirt, Speeduino and rusEFI), `.txt` is what AEM's and
      // ECUMaster's exporters write. Listing them is the whole of their
      // support — the format is sniffed from the content, never the
      // extension. `.gz` is the same again for a gzipped one: the Accessport
      // writes `.csv.gz`, and `decode_log_text` unwraps it by magic number.
      // `.vbo` is Racelogic's VBOX GPS log: text in bracketed sections, read by
      // its own parser (src/vbo.js) but routed exactly like the text exports
      // above — sniffed from the content, gzipped or not.
      // `.mlg` is TunerStudio's binary datalog — MegaSquirt, Speeduino and
      // rusEFI — decoded in Rust (MLG_EXTENSIONS in src-tauri/src/mlg.rs).
      filters: [
        {
          name: "Log files",
          extensions: [
            "csv",
            "msl",
            "txt",
            "tsv",
            "log",
            "vbo",
            "gz",
            "hlgzip",
            "MaxxECU-Zip-log",
            "MaxxECU-Log",
            "maxxlog",
            "MaxxECUZiplog",
            "llgx",
            "llg",
            "llg5",
            "ld",
            "ptd",
            "ptda",
            "elf",
            "mlg",
          ],
        },
        {
          name: "CSV / text log",
          extensions: ["csv", "msl", "txt", "tsv", "log", "vbo", "gz"],
        },
        { name: "Haltech NSP log", extensions: ["hlgzip"] },
        {
          name: "MaxxECU log",
          extensions: [
            "MaxxECU-Zip-log",
            "MaxxECU-Log",
            "maxxlog",
            "MaxxECUZiplog",
          ],
        },
        { name: "Link log", extensions: ["llgx", "llg", "llg5"] },
        { name: "MoTeC log", extensions: ["ld"] },
        { name: "SuperFlow dyno log", extensions: ["ptd", "ptda"] },
        { name: "EMtron log", extensions: ["elf"] },
        {
          name: "TunerStudio / MegaSquirt / Speeduino / rusEFI log",
          extensions: ["mlg"],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await feedFiles(inputId, paths);
  }

  // Intercept the <label> click that would normally trigger the hidden
  // <input type=file>. Capture phase + preventDefault keeps the browser
  // picker from opening.
  function hijackLabel(labelId, inputId, title) {
    const el = document.getElementById(labelId);
    if (!el) return;
    el.addEventListener(
      "click",
      (e) => {
        // For "Load Compare" the existing handler may clear an active overlay
        // — let that path through (it calls preventDefault itself).
        if (e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        pickAndOpen(inputId, title).catch((err) => console.error(err));
      },
      true,
    );
  }

  // Menu glyphs the bridge adds at runtime are inline SVG like the ones in
  // index.html, not emoji: an emoji codepoint renders in colour-emoji
  // presentation on Windows, which ignores the CSS `color`, so it never took
  // the theme's icon colour and stood out from every other item in the menu.
  function menuGlyph(d) {
    return (
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="' +
      d +
      '"/></svg>'
    );
  }

  // Add "Registered as Haltech Data Log Viewer" toggle (HKCU, no admin).
  // Registering here makes NSP's "Open log in viewer" hand this app the
  // legacy CSV; the bridge auto-upgrades to a same-basename .hlgzip
  // sidecar when one exists (see resolve_log_source in the Rust host).
  async function addNspToggle() {
    const menu = document.getElementById("tools-menu");
    if (!menu || menu.querySelector('[data-action="nsp-toggle"]')) return;

    const sep = document.createElement("div");
    sep.className = "cm-sep";
    menu.appendChild(sep);

    const item = document.createElement("div");
    item.className = "cm-item";
    item.dataset.action = "nsp-toggle";
    item.innerHTML =
      '<span class="ico">' +
      menuGlyph(
        "M6.5 9.5l3-3M5.5 10.5l-1 1a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M10.5 5.5l1-1a2.1 2.1 0 0 1 3 3L12 10a2.1 2.1 0 0 1-3 0",
      ) +
      '</span><span class="nsp-label">Set as Haltech DLV</span>';
    menu.appendChild(item);

    async function refresh() {
      try {
        const on = await invoke("nsp_is_registered");
        // Label stays the same on/off; the leading ✓ indicates active state.
        item.querySelector(".nsp-label").textContent = on
          ? "✓ Set as Haltech DLV"
          : "Set as Haltech DLV";
        item.dataset.on = on ? "1" : "0";
      } catch (e) {
        console.error(e);
      }
    }

    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.style.display = "none";
      const wasOn = item.dataset.on === "1";
      try {
        if (wasOn) await invoke("nsp_unregister");
        else await invoke("nsp_register");
      } catch (err) {
        if (typeof window.showToast === "function") {
          window.showToast("Registry update failed: " + err, "error");
        } else {
          alert("Registry update failed: " + err);
        }
        return;
      }
      await refresh();
      if (typeof window.showToast === "function") {
        window.showToast(
          wasOn
            ? "Unset as Haltech DLV"
            : "Set as Haltech DLV. NSP will now hand off logs here",
          "success",
        );
      }
    });

    const toolsBtn = document.getElementById("btn-tools-menu");
    if (toolsBtn) toolsBtn.addEventListener("click", refresh);
    await refresh();
  }

  // Tools -> Log load debug…: the transcript every load leaves behind —
  // the Rust decoder's step-by-step pipeline (for a .hlgzip: container
  // decrypt, hdefLibNex lookup, structure.xml enum extraction, overlay
  // matches; for the other containers their own stages), the read-and-decode total
  // and the frontend parse. For every format, so it is not a Haltech-only
  // item: a slow or wrong open of any log is diagnosed from here.
  function addLoadDebugMenuItem() {
    const menu = document.getElementById("tools-menu");
    if (!menu || menu.querySelector('[data-action="load-debug"]')) return;
    const item = document.createElement("div");
    item.className = "cm-item";
    item.dataset.action = "load-debug";
    item.innerHTML =
      '<span class="ico">' +
      menuGlyph(
        "M5 7a3 3 0 0 1 6 0v4a3 3 0 0 1-6 0zM6 5L4.5 3M10 5l1.5-2M2.5 8.5H5M11 8.5h2.5M3 13l2-1.5M13 13l-2-1.5",
      ) +
      "</span><span>Log load debug…</span>";
    menu.appendChild(item);
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.style.display = "none";
      showLoadDebugPopup();
    });
  }

  function showLoadDebugPopup() {
    let overlay = document.getElementById("load-debug-overlay");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "load-debug-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.55);" +
      "z-index:100000;display:flex;align-items:center;justify-content:center;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "background:#1e1e1e;color:#e8e8e8;" +
      "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;" +
      "width:min(920px,94vw);height:min(720px,90vh);" +
      "border:1px solid #444;border-radius:6px;display:flex;flex-direction:column;" +
      "box-shadow:0 12px 40px rgba(0,0,0,0.7);";
    const bar = document.createElement("div");
    bar.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 12px;" +
      "border-bottom:1px solid #333;background:#242424;";
    bar.innerHTML =
      '<span style="font-weight:600">Log load debug</span>' +
      '<span id="hgzd-sub" style="opacity:0.7;font-size:11px"></span>' +
      '<span style="flex:1"></span>' +
      '<button id="hgzd-copy" style="padding:4px 10px">Copy</button>' +
      '<button id="hgzd-close" style="padding:4px 10px">Close</button>';
    const body = document.createElement("pre");
    body.style.cssText =
      "flex:1;margin:0;padding:12px 14px;overflow:auto;" +
      "white-space:pre-wrap;word-break:break-word;";
    const transcripts = window.__tsLoadTranscripts || [];
    if (transcripts.length === 0) {
      body.textContent =
        "No logs loaded in this session yet.\n\n" +
        "Open a log and re-open this dialog: every decoder reports its stages here, " +
        "with the time taken to read it and the time taken to parse it.";
    } else {
      // Haltech only: cross-reference the Type-token histogram against the
      // app's unit table (source of truth for scaling) so the user
      // can see which HLGZIP tokens don't yet have a UNIT_DATA entry and are
      // therefore rendered as raw ints. The line only exists in a .hlgzip
      // transcript, so every other format skips this. UNIT_DATA lives in the
      // page's global scope after the app loads.
      const knownTypes =
        typeof window.UNIT_DATA === "object" && window.UNIT_DATA
          ? new Set(Object.keys(window.UNIT_DATA))
          : null;
      const parts = transcripts
        .slice()
        .reverse()
        .map((t) => {
          const when = new Date(t.ts).toLocaleTimeString();
          const upTag = t.upgraded ? " (upgraded from .csv sidecar)" : "";
          let lines = t.lines.slice();
          if (knownTypes) {
            const histLine = lines.find(
              (l) => l.indexOf("Type token histogram") >= 0,
            );
            if (histLine) {
              const tokens = histLine
                .replace(/^.*histogram:\s*/, "")
                .split(",")
                .map((s) => s.trim().split("=")[0])
                .filter(Boolean);
              const missing = tokens.filter(
                (tok) => !knownTypes.has(tok) && tok !== "Other",
              );
              if (missing.length) {
                lines.push(
                  "[app] Types with no unit table (rendered as raw): " +
                    missing.join(", "),
                );
              } else {
                lines.push("[app] every Type token has a unit table");
              }
            }
          }
          const tag =
            (t.format ? t.format : "") +
            (t.via && t.via !== "open" ? ", " + t.via : "");
          return (
            "── " +
            when +
            "  " +
            t.name +
            (tag ? "  [" + tag + "]" : "") +
            upTag +
            "\n" +
            (t.path ? "path : " + t.path + "\n" : "") +
            (t.upgraded ? "orig : " + t.origPath + "\n" : "") +
            lines.map((l) => "  " + l).join("\n")
          );
        });
      body.textContent = parts.join("\n\n");
    }
    panel.appendChild(bar);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const sub = document.getElementById("hgzd-sub");
    if (sub) sub.textContent = transcripts.length + " load(s) captured";
    document
      .getElementById("hgzd-close")
      .addEventListener("click", () => overlay.remove());
    document.getElementById("hgzd-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(body.textContent);
      } catch (e) {
        console.error(e);
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  // Expose a native Save dialog for the page. Called by exportPrefs() so
  // "Save Layout" prompts the user instead of silently dumping a file into
  // the Downloads folder.
  window.tauriSaveText = async function (suggestedName, content) {
    const target = await dialog.save({
      title: "Save layout",
      defaultPath: await defaultOpenDir().then((d) =>
        d ? `${d}\\${suggestedName}` : suggestedName,
      ),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!target) return false;
    await invoke("write_text_file", { path: target, content });
    lastDir = dirname(target);
    return true;
  };

  // Copy an NSP paste-table blob to the system clipboard through the Rust
  // host. NSP reads the clipboard directly and needs LF-only CF_UNICODETEXT,
  // which a WebView clipboard write (CRLF-normalised) can't provide — the
  // host sets the Win32 clipboard itself. Windows-only; on other platforms
  // the command returns an error and the caller falls back to a browser copy.
  window.tauriCopyNspTable = async function (content) {
    await invoke("copy_nsp_table_text", {
      text: String(content == null ? "" : content),
    });
    return true;
  };

  // Open an external URL (e.g. Stripe Checkout / Billing Portal) in the
  // user's default browser instead of the app's WebView.
  window.tauriOpenUrl = async function (url) {
    try {
      const opener = window.__TAURI__ && window.__TAURI__.opener;
      if (opener && typeof opener.openUrl === "function") {
        await opener.openUrl(url);
        return true;
      }
      await invoke("plugin:opener|open_url", { url });
      return true;
    } catch (e) {
      console.error("tauriOpenUrl failed", e);
      return false;
    }
  };

  // ---- Auto-updater (GitHub-hosted) -------------------------------------
  // Checks the public releases repo for a newer signed build. On startup we
  // check silently; the Tools-menu item below lets the user check on demand.
  function notify(msg, kind) {
    if (typeof window.showToast === "function") window.showToast(msg, kind);
    else console.log(msg);
  }

  let updateInFlight = false;
  // The update found by the last check, held open so the toast's Install
  // button can download it later. Keyed by version: a second check that finds
  // the same version reuses the toast already on screen / in the bell history
  // (showToast dedupes on `key`), so the user never sees two prompts for one
  // update. The old native dialog stacked two or three, because a WebView2
  // reload re-ran the startup check while the OS dialog from the previous
  // page was still open — a toast lives in the page and dies with it.
  let pendingUpdate = null;
  let installStarted = false;
  let installLabel = "Install";

  // Keep the popup's Install button and the toast's button telling the same
  // story: the toast reads "View" until a download starts, then both read the
  // download state.
  function setInstallState(handle, label, disabled) {
    installLabel = label;
    if (handle) handle.setAction(disabled ? label : "View", disabled);
    const popup = window.tsUpdatePopup;
    if (popup) popup.setInstall(label, disabled);
  }

  function installUpdate(handle) {
    const update = pendingUpdate;
    if (!update || installStarted) return;
    installStarted = true;
    setInstallState(handle, "Downloading…", true);
    (async () => {
      try {
        await update.downloadAndInstall();
        setInstallState(handle, "Restarting…", true);
        await window.__TAURI__.process.relaunch();
      } catch (e) {
        console.error("update install failed", e);
        installStarted = false;
        setInstallState(handle, "Install", false);
        notify("Update install failed: " + (e && e.message ? e.message : e));
      }
    })();
  }

  // The toast's button opens the popup with the release notes and the
  // Install / Later choice; Install there runs the download.
  function viewUpdate(handle) {
    const update = pendingUpdate;
    const popup = window.tsUpdatePopup;
    if (!update || !popup) return;
    popup.open({
      version: update.version,
      notes: update.body || "",
      installLabel,
      installDisabled: installStarted,
      onInstall: () => installUpdate(handle),
    });
  }

  function offerUpdate(update) {
    if (typeof window.showToast !== "function") return;
    const prev = pendingUpdate;
    pendingUpdate = update;
    // Same version as the one already offered: keep the earlier handle, close
    // the duplicate resource (nothing uses it).
    if (prev && prev.version === update.version) {
      pendingUpdate = prev;
      try {
        update.close();
      } catch {}
    } else if (prev) {
      try {
        prev.close();
      } catch {}
    }
    window.showToast(`Update available: version ${update.version}.`, "update", {
      key: "update:" + update.version,
      action: { label: "View", run: viewUpdate },
    });
  }

  async function checkForUpdates({ silent }) {
    const updater = window.__TAURI__ && window.__TAURI__.updater;
    if (!updater || typeof updater.check !== "function") {
      if (!silent) notify("Updates are unavailable in this build.");
      return;
    }
    if (updateInFlight || installStarted) return;
    updateInFlight = true;
    try {
      const update = await updater.check();
      if (!update) {
        if (!silent) notify("You're on the latest version.", "success");
        return;
      }
      offerUpdate(update);
    } catch (e) {
      console.error("update check failed", e);
      if (!silent)
        notify("Update check failed: " + (e && e.message ? e.message : e));
    } finally {
      updateInFlight = false;
    }
  }

  // Add a "Check for updates" item to the Tools menu (same pattern as the NSP
  // toggle above).
  function addUpdateMenuItem() {
    const menu = document.getElementById("tools-menu");
    if (!menu || menu.querySelector('[data-action="check-updates"]')) return;

    const item = document.createElement("div");
    item.className = "cm-item";
    item.dataset.action = "check-updates";
    item.innerHTML =
      '<span class="ico">' +
      menuGlyph("M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11") +
      "</span><span>Check for updates…</span>";
    menu.appendChild(item);

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.style.display = "none";
      checkForUpdates({ silent: false });
    });
  }

  // Custom titlebar: tauri.conf.json sets decorations:false so the OS-drawn
  // title bar (which eats a disproportionate amount of vertical space on a
  // normal-DPI Windows screen) is replaced with the slim #app-titlebar bar
  // markup in index.html. That bar is hidden by default (nothing to control
  // in the browser build); reveal + wire it up here since this whole script
  // is already a no-op outside Tauri.
  function initTitlebar() {
    const bar = document.getElementById("app-titlebar");
    const tauriWindow = window.__TAURI__ && window.__TAURI__.window;
    if (
      !bar ||
      !tauriWindow ||
      typeof tauriWindow.getCurrentWindow !== "function"
    )
      return;
    const win = tauriWindow.getCurrentWindow();
    bar.classList.add("show");
    // Lets CSS elsewhere (e.g. #toast-host) clear the bar instead of
    // overlapping it.
    document.documentElement.classList.add("has-custom-titlebar");
    // Belt-and-suspenders for a known Windows/WebView2 issue where the
    // tauri.conf.json decorations:false setting (and even the Rust-side
    // set_decorations(false) call in the setup hook) can lose a race with
    // native window creation, leaving the OS title bar showing alongside
    // this custom one (tauri-apps/tauri#14859, #11296). Re-asserting it once
    // the frontend is up clears it reliably.
    if (typeof win.setDecorations === "function") {
      win.setDecorations(false).catch(() => {});
    }

    const minBtn = document.getElementById("tb-min");
    const maxBtn = document.getElementById("tb-max");
    const closeBtn = document.getElementById("tb-close");
    if (minBtn) minBtn.addEventListener("click", () => win.minimize());
    if (maxBtn) maxBtn.addEventListener("click", () => win.toggleMaximize());
    if (closeBtn) closeBtn.addEventListener("click", () => win.close());

    // Double-clicking the bar itself (not a button) toggles maximize, matching
    // native title bar behaviour. Buttons are plain (non-drag-region) children
    // of the drag-region bar, so their own clicks are unaffected.
    bar.addEventListener("dblclick", (e) => {
      if (e.target.closest(".tb-btn")) return;
      win.toggleMaximize();
    });

    async function syncMaximized() {
      try {
        const isMax = await win.isMaximized();
        if (maxBtn) {
          maxBtn.classList.toggle("is-maximized", isMax);
          maxBtn.title = isMax ? "Restore" : "Maximize";
        }
      } catch (e) {
        /* best effort */
      }
    }
    syncMaximized();
    win.onResized(() => syncMaximized());
  }

  // Startup splash handshake (see splash.html + reveal_main_window in main.rs).
  // The main window is created hidden, so nothing is on screen until we say the
  // UI is drawn — that's what removes the white flash. Signal as soon as the
  // page has finished loading and laid out; the app's own #loading-overlay
  // covers anything slower that follows (restoring the previous session's logs).
  function signalFrontendReady() {
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      invoke("frontend_ready").catch(() => {});
    };
    const afterPaint = () => {
      // requestAnimationFrame is throttled while the window is still hidden, so
      // it can't be the only path here — race it against a short timer.
      requestAnimationFrame(() => requestAnimationFrame(send));
      setTimeout(send, 250);
    };
    if (document.readyState === "complete") afterPaint();
    else window.addEventListener("load", afterPaint, { once: true });
    // Last resort: never leave the window hidden because 'load' never fired.
    setTimeout(send, 8000);
  }

  function init() {
    // The "Load Log" label has no id in the markup; tag it by its `for`.
    const loadLogLabel = document.querySelector('label[for="file-input"]');
    if (loadLogLabel && !loadLogLabel.id) loadLogLabel.id = "load-log-label";

    hijackLabel("load-log-label", "file-input", "Open log");
    addNspToggle();
    addLoadDebugMenuItem();
    addUpdateMenuItem();
    initTitlebar();
    signalFrontendReady();

    // Silent check on startup — an update toast only if one is found.
    checkForUpdates({ silent: true });

    // CLI / second-instance: pick up a pending file path (e.g. NSP's "open
    // log in viewer" hand-off). Wait for the previous session's logs to
    // finish restoring first — restoreLoadedLogs() sets Main/Compare from
    // the saved session as its very last step, and running concurrently with
    // it would let that overwrite the hand-off file right back out of view
    // after addLog() had just made it the Main log.
    Promise.resolve(window.__tsRestoreLoadedLogsPromise).then(() => {
      invoke("take_pending_file").then((p) => {
        if (p) feedInput("file-input", p).catch((err) => console.error(err));
      });
    });

    listen("open-file", (e) => {
      const p = e && e.payload;
      if (p)
        feedInput("file-input", String(p)).catch((err) => console.error(err));
    });

    // Note: window-level OS file drag-and-drop is intentionally disabled
    // (tauri.conf.json -> dragDropEnabled: false) because WebView2's file-drop
    // handler swallows HTML5 dragstart/dragover/drop events and breaks the
    // in-app channel drag (sidebar -> trace, trace -> trace). Files are
    // opened via the native dialog, CLI arg, and single-instance handoff.
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
