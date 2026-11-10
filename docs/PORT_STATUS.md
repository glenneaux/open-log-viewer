# Port status

This is a working browser/desktop port in progress, not feature parity with the original executable.

## Verified

- Browser startup, offline CSV import, trace creation.
- Single-stream Haltech HEPS decryption, ZIP decompression with CRC verification, HLG metadata and samples, and browser rendering.
- Independent NSP CSV comparison for the supplied private log.
- Electron desktop startup with sandboxing, context isolation and Node integration disabled.
- Full-height browser workspace at multiple viewport sizes.
- MLVLG v1/v2 scalar and named-bit decoding has synthetic tests for signed values, scaling, timestamp wrap, marker anchoring, invalid bit metadata and checksum rejection; real-file validation is pending.
- Desktop file handoff and window-size persistence are implemented; cross-platform validation is pending.
- MoTeC LD decoding and Haltech session merging pass synthetic tests; no real samples of these variants have been provided. See the main README for alignment semantics and limits.
- MaxxECU ZIP text-stream extraction passes stored/deflated, corruption and browser-import tests. Real packages, metadata-derived timing and tune units remain unvalidated or unimplemented as detailed in the README. Binary `.maxxlog` remains unsupported.

## Retained, needs broader regression testing

The recovered frontend contains comparisons, math channels, alarms, table generation, GPS tools, layout persistence and text-format parsers. Formatting preserves its bundled structure; identifiers and modules still need maintainability work.

## Not implemented or incomplete

- Other native binary formats: see [fixture checklist](FIXTURES.md).
- Multi-session HLG and multiple-stream containers are implemented and synthetically tested; real-world validation and absolute wall-clock gap reconstruction remain pending.
- Haltech tune snapshots, password-protected map workflows, HDEF enum labels and tune-table catalogues.
- Native chunked column cache, blob/archive storage and very-large-log behavior. Browser HLG expansion is limited to 512 MB.
- NSP registration and automatic updates. Electron replaces the original Tauri host.
- Original hosted cloud sync, billing, administrative tools and feedback services. Original service endpoints are disconnected; local features require no subscription.
- Unknown Haltech unit IDs display as unscaled `Other`; only unit IDs verified against the reference CSV are mapped.

No original executable is used at runtime. The original Rust source was not available. Do not treat the decompilation workspace as buildable source.
