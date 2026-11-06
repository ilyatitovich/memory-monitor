# Changelog

## [1.0.0] - 2026-11-06

### Added

- First release of `memory-monitor`: sample Chrome’s JS heap, detect sustained leaks and high usage, and report once per session through your `log` callback.
- Optional `getTabCount` and `getMeasures` for tab count and live app counters in report metadata.
- Exported helpers: `detectMemoryLeak`, `usedJsHeapSizeMb`, `MEMORY_EVENT`, and `THRESHOLD_PRESETS`.
