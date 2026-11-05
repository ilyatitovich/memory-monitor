# memory-monitor

Chrome-oriented library that samples `performance.memory.usedJSHeapSize` and reports at most one potential memory leak and one high-usage event per monitor instance via an injected `log` callback.

Zero runtime dependencies.

## Install

```bash
pnpm add memory-monitor
```

Requires a build that can resolve the package’s ESM export (`dist/index.js` + types).

## Quick start

```ts
import { MemoryMonitor } from "memory-monitor";

const monitor = new MemoryMonitor({
  log(message, metadata) {
    // Forward to your remote logger / analytics sink
    console.warn(message, metadata);
  },
  // Optional: included in report metadata when provided
  getTabCount: () => window.open?.length ?? 1,
  // Optional overrides — see Settings below
  highUsageMb: 2500,
});

// Optional: app-level counters for leak attribution
monitor.setMeasures({
  openModals: 2,
  cachedItems: 1400,
});

monitor.start();

// Later…
monitor.stop();

// Re-arm one-shot alerts and clear sample history for a new session
monitor.reset();
monitor.start();
```

`start()` is a no-op when already running, or when Chrome’s `performance.memory` API is unavailable (for example Firefox). There is no separate “unsupported” callback — check support yourself if you need a signal.

Import `THRESHOLD_PRESETS.catastrophic` (defaults) or `THRESHOLD_PRESETS.sensitive` when you want earlier warnings and can tolerate more noise:

```ts
import { MemoryMonitor, THRESHOLD_PRESETS } from "memory-monitor";

new MemoryMonitor({ log, ...THRESHOLD_PRESETS.sensitive });
```

## Browser support

| Environment                                                      | Behavior                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| Chromium with `performance.memory`                               | Samples heap; may emit leak / high-usage logs        |
| Firefox, Safari, and other browsers without `performance.memory` | `start()` returns immediately; no timer is started   |
| Node / non-browser                                               | Unsupported (`window.performance` / `memory` absent) |

`performance.memory` is a **non-standard Chrome API**. It is coarse (roughly megabyte granularity), can be affected by GC timing, and may be restricted or unavailable under certain cross-origin isolation / privacy settings. Treat alerts as catastrophic signals, not precise profilers.

## One-shot semantics

Each armed session emits:

- **at most one** `"Detected potential memory leak"` event
- **at most one** `"High memory usage"` event (if `reportHighUsage` is enabled)

`stop()` only clears the sampling timer. Snapshot history and warn flags persist across `stop()` / `start()`, so alerts stay one-shot for that session. Call `reset()` to clear samples, baselines, detected leak state, and warn flags and begin a new armed session (with or without stopping first).

If `log` or `getTabCount` throws, the tick is caught and the corresponding one-shot flag is **not** set, so the next successful tick can still report. Missing `document` is treated as `tabVisible: false` without dropping the report.

## Settings

Pass any subset of these on the constructor; omitted fields use the defaults below.

| Setting                      | Default           | Meaning                                                               |
| ---------------------------- | ----------------- | --------------------------------------------------------------------- |
| `highUsageMb`                | `2500`            | Absolute heap size (MB) that triggers a high-usage report             |
| `leakGrowthMb`               | `1500`            | Minimum growth (MB) across the sliding window to count as a leak      |
| `sustainedGrowthMbPerSecond` | `1`               | Later-half least-squares slope must exceed this (MB/s)                |
| `measurementIntervalMs`      | `10000`           | Sampling interval                                                     |
| `slidingWindowMs`            | `600000` (10 min) | How long samples are retained                                         |
| `minWindowCoverageMs`        | `300000` (5 min)  | Minimum span between first and last sample before leak detection runs |
| `minLeakSamples`             | `5`               | Minimum samples required for leak detection                           |
| `maxMeasureDeltas`           | `20`              | Cap on measure keys included in `measureGrowth`                       |
| `maxHeapHistoryPoints`       | `20`              | Cap on downsampled points in `heapSizeHistory`                        |
| `reportHighUsage`            | `true`            | When `false`, only leak events are reported                           |

### Leak heuristic (summary)

A leak is reported when the sliding window has enough samples and coverage, total growth is at least `leakGrowthMb`, and the **later half** of the window still climbs faster than `sustainedGrowthMbPerSecond`. That combination is meant to ignore short GC sawtooth / hydration spikes while catching sustained catastrophic growth.

`detectMemoryLeak(snapshots, settings?)` is also exported for unit-testing the heuristic in isolation.

## Log events and payload shape

`log` is called as `log(message, metadata)`.

### `"Detected potential memory leak"`

```ts
{
  usedJSHeapSizeMb: number;
  sessionDurationMinutes: number; // from performance.now()
  tabVisible: boolean;            // document.visibilityState === "visible"
  measures: Record<string, number>;
  tabCount?: number;              // only if getTabCount was provided
  leak: {
    growthMb: number;
    growthRatePerSecondTrend: number;
    windowCoverageMinutes: number;
  };
  heapSizeHistory: Array<{
    minutesAgo: number;
    usedJSHeapSizeMb: number;
  }>;
  measureGrowth?: {
    sinceMinutesAgo: number;
    counts: Record<string, number>; // largest non-zero deltas vs baseline
  };
}
```

### `"High memory usage"`

```ts
{
  threshold: number; // settings.highUsageMb
  usedJSHeapSizeMb: number;
  sessionDurationMinutes: number;
  tabVisible: boolean;
  measures: Record<string, number>;
  tabCount?: number;
}
```

## API surface

| Member                                                | Role                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| `new MemoryMonitor({ log, getTabCount?, …settings })` | Create a monitor                                   |
| `setMeasures(counts)`                                 | Replace app counters included in reports (copied)  |
| `start()` / `stop()`                                  | Begin or end sampling (`stop` keeps session state) |
| `reset()`                                             | Clear samples, baselines, and one-shot flags       |
| `getMemoryInfo()`                                     | `{ memoryUsage, leak }` for the current window     |
| `MEMORY_EVENT`                                        | Stable log message strings (`LEAK`, `HIGH_USAGE`)  |
| `THRESHOLD_PRESETS`                                   | `catastrophic` (defaults) and `sensitive` packs    |
| `usedJsHeapSizeMb()`                                  | Read Chrome heap size in MB, or `undefined`        |
| `detectMemoryLeak(snapshots, settings?)`              | Pure leak check used by the monitor                |

Design notes and portfolio case studies: [DESIGN.md](./DESIGN.md).

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test    # c8 with 100% coverage gate
```

CI runs typecheck, build, and test on Node 24 for pushes and pull requests.

## License

MIT
