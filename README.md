# Open Log Viewer

Work in progress: GPL-3.0 port of TS Log Viewer 1.10.0, reconstructed from the supplied executable with the user's stated permission.

## Run

Requires Node.js 24 or newer. Run `node server.mjs` and open http://127.0.0.1:4173. No dependency installation is needed to run the browser viewer. Logs are read locally in the browser. Use **Add Log** to open CSV or a supported single-stream `.hlgzip` file.

For the desktop wrapper, run `pnpm install`, `node node_modules/electron/install.js`, then `pnpm desktop`.

## CSV export

Select the main log and click **Export CSV**. This exports all recorded channels and samples (not just visible traces), using Haltech-style `Channel`/`Type` headers. Values retain their native representation and type metadata, rather than being converted to the current display units. Error codes are preserved; missing values are blank. Calculated channels are excluded. Timestamps are relative to the log start, at millisecond precision.

## Tracking remaining work

### Implemented, awaiting real-file validation

- **MoTeC `.ld`:** integer and floating-point samples, channel scaling and mixed sample rates. Synthetic tests pass. Mixed-rate channels use sample-and-hold; no values are extended past a channel's recording end. M1/ADL variants, enums and `.ldx` lap metadata still need real-file coverage.
- **Haltech multi-session/bundled HLG:** merges channels by ID and unit type, leaves missing channels blank, and shifts restarted clocks onto a continuous timeline. Synthetic tests pass, but no real multi-session container has been supplied. When a clock restarts, the actual gap between sessions is unknown; the importer uses one sample interval and records that adjustment internally.
- **MLVLG v2:** synthetic decoding and browser-import tests pass; real rusEFI/MegaSquirt recordings remain untested.

Single-session Haltech import remains verified against the supplied NSP CSV. Unsupported binary formats remain listed separately below; they are not described as merely untested.

- [Log files to collect and reference exports](docs/FIXTURES.md)
- [Feature coverage and incomplete implementations](docs/PORT_STATUS.md)

Run `pnpm test` for decoder tests and `pnpm test:browser` for browser tests. The latter uses Microsoft Edge locally. Private fixture tests require the environment variables described in the fixture checklist.

## Current verification

- Browser startup and CSV loading pass an automated browser smoke test: four samples, two channels, no uncaught exceptions and no remote requests.
- Recovered frontend includes plotting, comparisons, math channels, tables, alarms and layout tools; those features still need individual regression tests.
- Local subscription gating is disabled. The original hosted cloud service is disconnected.
- Haltech import decodes and plots 642 recorded channels and 45,670 samples from the supplied private log. All 29,319,498 values shared with its independent NSP CSV export match, along with timestamps, names and unit types. The viewer can add calculated channels on top of the recorded channels.
- Electron desktop startup passes its smoke test with Node integration disabled in the renderer.

## Not yet a complete desktop port

The Rust backend, native file integrations, binary log parsers, engine storage and hosted service implementation have not been fully reconstructed. The recovered desktop bridge is retained as interface documentation and is inactive in browser mode. No original executable is required by the browser build.

The original JavaScript bundle is formatted for inspection; minified identifiers have not yet been renamed. Third-party vendored code retains its existing licence notices. Personal test logs and reverse-engineering working files are not part of this project.
