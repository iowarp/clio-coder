# tests

- [Contract tests](contracts.md) — The contract test suite that guards Clio's behavioral invariants, covering state isolation, dispatch routing, engine lifecycle, smoke tests of the built binary, ACP boundary behavior, and import-boundary enforcement.
- [Tests extended](extended.md) — The tests/extended suite: how the full end-to-end behavior of the TUI, compaction lifecycle, library import/browser, dispatch board, configure wizard, and rendering invariants is exercised under pnpm run test:full, and the isolation harness they share.
