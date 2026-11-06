# Design Notes

Portfolio-oriented write-up of the engineering decisions behind `@ilyatitovich/memory-monitor`.

## Problem

Long-lived Chromium tabs can grow until the process is killed, often without a clear “which feature did this?” signal in production. Standard APIs do not expose a precise JS heap size; Chrome’s non-standard `performance.memory.usedJSHeapSize` is coarse but enough to detect **catastrophic** growth and attach app-level counters for triage.

## Architecture

```text
Caller ──log / getTabCount / getMeasures──► MemoryMonitor
                                              │
                         setInterval ─────────┤
                                              ▼
                                    usedJsHeapSizeMb()
                                              │
                         sliding window of HeapSnapshot
                                              │
                         detectMemoryLeak (pure) + high-usage check
                                              │
                         report once per armed session via log()
```

Boundaries that matter:

- **Injected `log`** — no vendor lock-in; the app owns transport and PII policy.
- **Pure `detectMemoryLeak`** — heuristic is unit-testable without timers or DOM.
- **Private monitor state** — consumers cannot mutate snapshots or warn flags; `reset()` is the supported re-arm path.
- **Zero runtime dependencies** — failure modes stay inside this module and the caller’s sink.

## Leak Heuristic

Defaults target near-crash growth, not slow leaks:

1. At least `minLeakSamples` samples spanning `minWindowCoverageMs`.
2. Net growth across the window ≥ `leakGrowthMb` (default 1500 MB).
3. Least-squares slope on the **later half** of the window exceeds `sustainedGrowthMbPerSecond` (default 1 MB/s).

Why the later half: hydration spikes and GC sawteeth often rise then flatten. Requiring the second half to keep climbing filters one-shot allocations that a naive “first vs last” check would mislabel as leaks. Scenario tests under `tests/memory-monitor.edge-cases.test.ts` encode those patterns.

`THRESHOLD_PRESETS.sensitive` lowers the bars for earlier signal at the cost of more false positives. Prefer measuring in your app before changing production defaults.

## Measure Attribution

`getMeasures`, passed to the constructor, is called on each sample and copied into a null-prototype record. A pull callback is useful because the counters that explain a leak are whichever values exist at sample time; the monitor reads them itself instead of depending on a setter the app must remember to call before that tick. Baselines are retained (at most two, spaced across half the sliding window). On a leak report, `measureGrowth` lists the largest non-zero deltas versus the oldest baseline so on-call engineers see which app-level tallies moved with the heap.

Prototype keys such as `toString` are handled with `Object.hasOwn` so inherited `Object.prototype` values never look like baselines.

## Reliability Choices

| Decision | Rationale |
| --- | --- |
| Set one-shot flags **after** successful `log` | A throwing sink must not permanently silence the only alert. |
| Swallow errors inside the interval tick | Uncaught `setInterval` errors are easy to miss in production. |
| `stop()` keeps session state; `reset()` re-arms | Explicit lifecycle for SPAs that pause monitoring without intending a new session. |
| Sample time via `performance.now()` | Monotonic window math; wall-clock jumps must not poison eviction. |
| Defensive copies of `measures` | Async loggers must not observe later mutation of the caller’s object. |

## Chrome Verification Methodology (No In-Repo Browser Harness)

A full Playwright/Chromium harness is intentionally out of scope for this package’s CI cost. To validate against real GC coarseness:

1. Build (`pnpm run build`) and load `dist/index.js` from a Chromium page that is cross-origin isolated if you need finer `performance.memory` granularity.
2. Drive a controlled allocator (e.g. retain large `ArrayBuffer`s on an interval) while `getMeasures` returns a matching counter.
3. Confirm a single leak event, inspect `heapSizeHistory` and `measureGrowth`, then `reset()` and repeat.
4. Background the tab for several minutes and note timer throttling versus `minLeakSamples` / `minWindowCoverageMs`.

Record false-positive rate under “allocate then release” workloads before adopting `THRESHOLD_PRESETS.sensitive` in production.

## Supply Chain and Lint Posture

- **Lint gate** = TypeScript `strict` typecheck (`pnpm run lint`), matching CI.
- **Runtime dependencies**: none; `pnpm run audit:prod` must stay clean at high severity.
- **Dev tooling** (`c8` → `glob` / `minimatch`): moderate advisories may appear in a full `pnpm audit`. They do not ship in `dist/`. Prefer upgrading `c8` when a fixed release exists; do not downgrade solely to silence noise if it breaks the coverage gate.

## Case Studies Worth Presenting

1. **Heuristic design** — total growth + later-half slope vs simple thresholds; GC/hydration fixtures.
2. **Attribution without framework coupling** — copied measures and capped deltas for on-call triage.
3. **Testing non-standard browser APIs in Node** — clock, heap, and timer fakes with a 100% coverage gate that still asserts behavior.
4. **Hardening a tiny library** — one-shot alerts, publish `prepack`, private API, dist smoke import, monotonic sampling.
