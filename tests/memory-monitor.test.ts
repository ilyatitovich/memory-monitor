import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  detectMemoryLeak,
  MemoryMonitor,
  usedJsHeapSizeMb,
} from "../index.ts";
import type { HeapSnapshot } from "../index.ts";
import {
  createLogMock,
  installChromeHeap,
  installClock,
  resetGlobals,
} from "./test-helpers.ts";

const MINUTE = 60_000;
const MB = 1024 * 1024;

function snapshots(points: [number, number][]): HeapSnapshot[] {
  return points.map(([minutes, mb]) => ({
    timestamp: minutes * MINUTE,
    usedJSHeapSizeMb: mb,
  }));
}

const climbingLeak = snapshots([
  [0, 100],
  [1, 400],
  [2, 700],
  [3, 1000],
  [4, 1300],
  [5, 1600],
  [6, 1900],
]);

describe("usedJsHeapSizeMb", { concurrency: false }, () => {
  afterEach(resetGlobals);

  it("returns undefined when window is missing", () => {
    Reflect.deleteProperty(globalThis, "window");
    assert.equal(usedJsHeapSizeMb(), undefined);
  });

  it("returns undefined when usedJSHeapSize is not a number", () => {
    Object.defineProperty(globalThis, "window", {
      value: { performance: { memory: { usedJSHeapSize: "big" } } },
      configurable: true,
    });
    assert.equal(usedJsHeapSizeMb(), undefined);
  });

  it("returns undefined when window exists without a performance object", () => {
    Object.defineProperty(globalThis, "window", {
      value: { performance: undefined },
      configurable: true,
    });
    assert.equal(usedJsHeapSizeMb(), undefined);
  });

  it("rounds Chrome heap bytes to the nearest megabyte", () => {
    const heap = installChromeHeap({ bytes: 1.6 * MB });
    assert.equal(usedJsHeapSizeMb(), 2);
    heap.restore();
  });

  it("swallows a throwing memory getter", () => {
    const heap = installChromeHeap({ throwOnMemory: true });
    assert.equal(usedJsHeapSizeMb(), undefined);
    heap.restore();
  });
});

describe("detectMemoryLeak", () => {
  it("returns nothing for fewer than five samples", () => {
    assert.equal(
      detectMemoryLeak(
        snapshots([
          [0, 100],
          [2, 900],
          [4, 1700],
          [6, 2500],
        ]),
      ),
      undefined,
    );
  });

  it("returns nothing when the window is shorter than five minutes", () => {
    assert.equal(
      detectMemoryLeak(
        snapshots([
          [0, 100],
          [1, 500],
          [2, 900],
          [3, 1300],
          [4, 1700],
        ]),
      ),
      undefined,
    );
  });

  it("returns nothing when net growth is below 1500MB", () => {
    assert.equal(
      detectMemoryLeak(
        snapshots([
          [0, 100],
          [1, 200],
          [2, 300],
          [3, 400],
          [4, 500],
          [5, 600],
          [6, 700],
        ]),
      ),
      undefined,
    );
  });

  it("treats flattened growth as not a leak", () => {
    assert.equal(
      detectMemoryLeak(
        snapshots([
          [0, 100],
          [1, 700],
          [2, 1300],
          [3, 1700],
          [4, 1700],
          [5, 1700],
          [6, 1700],
        ]),
      ),
      undefined,
    );
  });

  it("reports a sustained climb over five minutes as a leak", () => {
    const leak = detectMemoryLeak(climbingLeak);
    assert.deepEqual(leak, {
      growthMb: 1800,
      growthRatePerSecondTrend: 5,
      windowCoverageMinutes: 6,
    });
  });

  it("returns nothing when the later half has too few points to fit a slope", () => {
    assert.equal(
      detectMemoryLeak(
        snapshots([
          [0, 100],
          [0, 100],
          [0, 100],
          [0, 100],
          [6, 2000],
        ]),
      ),
      undefined,
    );
  });

  it("returns nothing when later-half samples share one timestamp", () => {
    assert.equal(
      detectMemoryLeak(
        snapshots([
          [0, 100],
          [6, 2000],
          [6, 2100],
          [6, 2200],
          [6, 2300],
        ]),
      ),
      undefined,
    );
  });

  it("returns nothing for a sparse sample list whose first slot is empty", () => {
    const sparse = new Array<HeapSnapshot | undefined>(5);
    sparse[1] = { timestamp: 0, usedJSHeapSizeMb: 100 };
    sparse[4] = { timestamp: 6 * MINUTE, usedJSHeapSizeMb: 2000 };
    assert.equal(detectMemoryLeak(sparse as HeapSnapshot[]), undefined);
  });

  it("honors caller thresholds", () => {
    const leak = detectMemoryLeak(
      snapshots([
        [0, 10],
        [0.01, 15],
        [0.02, 20],
      ]),
      {
        minLeakSamples: 3,
        minWindowCoverageMs: 1000,
        leakGrowthMb: 5,
        sustainedGrowthMbPerSecond: 0,
      },
    );
    assert.equal(leak?.growthMb, 10);
    assert.equal(leak?.windowCoverageMinutes, 0);
  });
});

describe("MemoryMonitor", { concurrency: false }, () => {
  afterEach(() => {
    mock.timers.reset();
    resetGlobals();
  });

  it("merges settings and stores measures", () => {
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      highUsageMb: 800,
      getTabCount: () => 2,
    });
    const measures = { cacheEntries: 99, listeners: 12 };
    monitor.setMeasures(measures);
    assert.equal(monitor.settings.highUsageMb, 800);
    assert.equal(monitor.settings.leakGrowthMb, 1500);
    assert.equal(monitor.measures.cacheEntries, 99);
    assert.equal(monitor.getTabCount?.(), 2);
  });

  it("does not start when the Chrome memory API is missing", () => {
    Reflect.deleteProperty(globalThis, "window");
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.start();
    assert.equal(monitor.isMonitoring, false);
  });

  it("does not start when window exists without performance", () => {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.start();
    assert.equal(monitor.isMonitoring, false);
    Reflect.deleteProperty(globalThis, "window");
  });

  it("does not start when performance.memory is not an object", () => {
    Object.defineProperty(globalThis, "performance", {
      value: { now: () => 0 },
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: { performance: globalThis.performance },
      configurable: true,
    });
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.start();
    assert.equal(monitor.isMonitoring, false);
    Reflect.deleteProperty(globalThis, "window");
  });

  it("starts once, samples on the interval, and stop is idempotent", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(1_000);
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: 10_000,
    });
    mock.timers.enable({ apis: ["setInterval"] });
    monitor.start();
    monitor.start();
    mock.timers.tick(10_000);
    assert.equal(monitor.snapshots.length, 1);
    monitor.stop();
    monitor.stop();
    assert.equal(monitor.isMonitoring, false);
    assert.equal(monitor.intervalId, undefined);
    heap.restore();
    clock.restore();
  });

  it("skips a sample when the heap reading is missing", () => {
    const heap = installChromeHeap({ throwOnMemory: true });
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.runMemoryCheck();
    assert.deepEqual(monitor.snapshots, []);
    heap.restore();
  });

  it("drops snapshots older than the sliding window", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      slidingWindowMs: MINUTE,
    });
    monitor.runMemoryCheck();
    clock.add(30_000);
    monitor.runMemoryCheck();
    clock.add(70_000);
    monitor.runMemoryCheck();
    assert.equal(monitor.snapshots.length, 1);
    assert.equal(monitor.snapshots[0]?.timestamp, 100_000);
    heap.restore();
    clock.restore();
  });

  it("logs a leak once with heap history and measure growth", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      getTabCount: () => 3,
    });
    monitor.setMeasures({ cacheEntries: 1000, listeners: 400 });

    for (let step = 0; step <= 6; step++) {
      heap.setMb(100 + step * 300);
      if (step === 3) {
        monitor.setMeasures({ cacheEntries: 8000, listeners: 400 });
      }
      monitor.runMemoryCheck();
      clock.add(MINUTE);
    }

    const leakLogs = calls.filter(
      (call) => call.message === "Detected potential memory leak",
    );
    assert.equal(leakLogs.length, 1);
    assert.equal(leakLogs[0]?.metadata.tabCount, 3);
    assert.equal(leakLogs[0]?.metadata.tabVisible, true);
    assert.equal(leakLogs[0]?.metadata.usedJSHeapSizeMb, 1600);
    assert.equal(leakLogs[0]?.metadata.sessionDurationMinutes, 2);
    const leak = leakLogs[0]?.metadata.leak as { growthMb: number };
    assert.equal(leak.growthMb, 1500);
    const growth = leakLogs[0]?.metadata.measureGrowth as {
      counts: Record<string, number>;
    };
    assert.equal(growth.counts.cacheEntries, 7000);
    const history = leakLogs[0]?.metadata.heapSizeHistory as unknown[];
    assert.ok(history.length >= 2);

    monitor.runMemoryCheck();
    assert.equal(
      calls.filter((call) => call.message === "Detected potential memory leak")
        .length,
      1,
    );

    const info = monitor.getMemoryInfo();
    assert.equal(info.memoryUsage, 1900);
    assert.equal(info.leak?.growthMb, 1800);
    heap.restore();
    clock.restore();
  });

  it("logs high usage once above the threshold", () => {
    const heap = installChromeHeap({ mb: 2501 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.runMemoryCheck();
    monitor.runMemoryCheck();
    const high = calls.filter((call) => call.message === "High memory usage");
    assert.equal(high.length, 1);
    assert.equal(high[0]?.metadata.threshold, 2500);
    heap.restore();
  });

  it("does not log high usage at the threshold or when reporting is off", () => {
    const heap = installChromeHeap({ mb: 2500 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.runMemoryCheck();
    assert.equal(calls.length, 0);

    heap.setMb(3000);
    const quiet = createLogMock();
    const dev = new MemoryMonitor({
      log: quiet.log,
      reportHighUsage: false,
    });
    dev.runMemoryCheck();
    assert.equal(quiet.calls.length, 0);
    heap.restore();
  });

  it("omits tabCount when the caller did not supply getTabCount", () => {
    const heap = installChromeHeap({ mb: 2600 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.runMemoryCheck();
    assert.equal("tabCount" in (calls[0]?.metadata ?? {}), false);
    heap.restore();
  });

  it("keeps two measure baselines five minutes apart and caps deltas", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      maxMeasureDeltas: 2,
      slidingWindowMs: 10 * MINUTE,
    });
    monitor.setMeasures({ A: 1, B: 1, C: 1 });
    monitor.runMemoryCheck();
    clock.add(4 * MINUTE);
    monitor.setMeasures({ A: 2, B: 2, C: 2 });
    monitor.runMemoryCheck();
    assert.equal(monitor.measureBaselines.length, 1);

    clock.add(MINUTE);
    monitor.runMemoryCheck();
    assert.equal(monitor.measureBaselines.length, 2);

    clock.add(5 * MINUTE);
    monitor.setMeasures({ A: 102, B: 52, C: 3, D: 1 });
    monitor.runMemoryCheck();
    assert.equal(monitor.measureBaselines.length, 2);

    const growth = monitor.computeMeasureGrowth(clock.value(), {
      A: 102,
      B: 52,
      C: 3,
    });
    heap.restore();
    clock.restore();
    assert.deepEqual(growth?.counts, { A: 100, B: 50 });
  });

  it("returns nothing from measure growth before the first baseline", () => {
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    assert.equal(monitor.computeMeasureGrowth(0, { cacheEntries: 1 }), undefined);
  });

  it("omits unchanged measures from growth", () => {
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.measureBaselines.push({
      timestamp: 0,
      counts: { cacheEntries: 10, listeners: 5 },
    });
    assert.deepEqual(
      monitor.computeMeasureGrowth(MINUTE, { cacheEntries: 10, listeners: 8 }),
      {
        sinceMinutesAgo: 1,
        counts: { listeners: 3 },
      },
    );
  });

  it("treats a newly appeared measure as growth from zero", () => {
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.measureBaselines.push({
      timestamp: 0,
      counts: { cacheEntries: 10 },
    });
    assert.deepEqual(
      monitor.computeMeasureGrowth(MINUTE, { cacheEntries: 10, sockets: 4 }),
      {
        sinceMinutesAgo: 1,
        counts: { sockets: 4 },
      },
    );
  });

  it("downsamples heap history and always keeps the latest sample", () => {
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      maxHeapHistoryPoints: 20,
    });
    const now = 21 * MINUTE;
    monitor.snapshots = Array.from({ length: 22 }, (_, index) => ({
      timestamp: index * MINUTE,
      usedJSHeapSizeMb: index,
    }));
    const history = monitor.serializeHeapHistory(now);
    assert.equal(history[0]?.minutesAgo, 21);
    assert.equal(history[history.length - 1]?.minutesAgo, 0);
    assert.equal(history[history.length - 1]?.usedJSHeapSizeMb, 21);
    assert.ok(history.length <= 21);
  });

  it("returns an empty heap history for no samples", () => {
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    assert.deepEqual(monitor.serializeHeapHistory(0), []);
  });

  it("reads a hidden tab as not visible", () => {
    const heap = installChromeHeap({ mb: 2600, visibilityState: "hidden" });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.runMemoryCheck();
    assert.equal(calls[0]?.metadata.tabVisible, false);
    heap.restore();
  });
});
