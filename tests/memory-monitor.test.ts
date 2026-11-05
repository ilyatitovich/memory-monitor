import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  detectMemoryLeak,
  MEMORY_EVENT,
  MemoryMonitor,
  THRESHOLD_PRESETS,
  usedJsHeapSizeMb,
} from "../index.ts";
import type { HeapHistoryPoint, HeapSnapshot, MeasureGrowth } from "../index.ts";
import {
  createLogMock,
  enableIntervalTimers,
  installChromeHeap,
  installClock,
  resetGlobals,
  TEST_INTERVAL_MS,
  tickInterval,
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

  it("exposes catastrophic and sensitive threshold presets", () => {
    assert.equal(THRESHOLD_PRESETS.catastrophic.highUsageMb, 2500);
    assert.ok(
      THRESHOLD_PRESETS.sensitive.leakGrowthMb <
        THRESHOLD_PRESETS.catastrophic.leakGrowthMb,
    );
    assert.ok(detectMemoryLeak(climbingLeak, THRESHOLD_PRESETS.sensitive));
  });
});

describe("MemoryMonitor", { concurrency: false }, () => {
  afterEach(() => {
    mock.timers.reset();
    resetGlobals();
  });

  it("applies settings overrides and includes measures and tab count in reports", () => {
    const heap = installChromeHeap({ mb: 801 });
    const { log, calls } = createLogMock();
    const measures = { cacheEntries: 99, listeners: 12 };
    const monitor = new MemoryMonitor({
      log,
      highUsageMb: 800,
      measurementIntervalMs: TEST_INTERVAL_MS,
      getTabCount: () => 2,
    });
    monitor.setMeasures(measures);
    enableIntervalTimers();
    monitor.start();
    tickInterval();

    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    assert.equal(calls[0]?.metadata.threshold, 800);
    assert.equal(calls[0]?.metadata.tabCount, 2);
    assert.deepEqual(calls[0]?.metadata.measures, measures);
    heap.restore();
  });

  it("ignores undefined settings overrides so defaults stay intact", () => {
    const heap = installChromeHeap({ mb: 2400 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      highUsageMb: undefined,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();

    assert.equal(calls.length, 0);
    heap.setMb(2501);
    tickInterval();
    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    assert.equal(calls[0]?.metadata.threshold, 2500);
    heap.restore();
  });

  it("rejects non-positive measurement and sliding-window intervals", () => {
    const { log } = createLogMock();
    assert.throws(
      () => new MemoryMonitor({ log, measurementIntervalMs: 0 }),
      {
        name: "RangeError",
        message: "measurementIntervalMs must be a positive number",
      },
    );
    assert.throws(
      () => new MemoryMonitor({ log, measurementIntervalMs: Number.NaN }),
      {
        name: "RangeError",
        message: "measurementIntervalMs must be a positive number",
      },
    );
    assert.throws(
      () => new MemoryMonitor({ log, slidingWindowMs: -1 }),
      {
        name: "RangeError",
        message: "slidingWindowMs must be a positive number",
      },
    );
  });

  it("copies measures on set and in report metadata", () => {
    const heap = installChromeHeap({ mb: 2600 });
    const { log, calls } = createLogMock();
    const measures = { cacheEntries: 10 };
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    monitor.setMeasures(measures);
    measures.cacheEntries = 999;
    enableIntervalTimers();
    monitor.start();
    tickInterval();

    const reported = calls[0]?.metadata.measures as Record<string, number>;
    assert.deepEqual(reported, { cacheEntries: 10 });
    assert.notEqual(reported, measures);
    reported.cacheEntries = 42;
    assert.equal(measures.cacheEntries, 999);
    heap.restore();
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

  it("does not start when performance.memory is missing", () => {
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

  it("does not start when performance.memory is null", () => {
    const performanceLike = { now: () => 0, memory: null };
    Object.defineProperty(globalThis, "performance", {
      value: performanceLike,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: { performance: performanceLike },
      configurable: true,
    });
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.start();
    assert.equal(monitor.isMonitoring, false);
    Reflect.deleteProperty(globalThis, "window");
  });

  it("does not start when usedJSHeapSize is missing or non-numeric", () => {
    for (const memory of [{}, { usedJSHeapSize: "big" }]) {
      const performanceLike = { now: () => 0, memory };
      Object.defineProperty(globalThis, "performance", {
        value: performanceLike,
        configurable: true,
      });
      Object.defineProperty(globalThis, "window", {
        value: { performance: performanceLike },
        configurable: true,
      });
      const { log } = createLogMock();
      const monitor = new MemoryMonitor({ log });
      monitor.start();
      assert.equal(monitor.isMonitoring, false);
    }
    Reflect.deleteProperty(globalThis, "window");
  });

  it("starts once, samples on the interval, and stop is idempotent", () => {
    const heap = installChromeHeap({ mb: 2600 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    monitor.start();
    assert.equal(monitor.isMonitoring, true);
    assert.equal(calls.length, 0);

    tickInterval();
    assert.equal(
      calls.filter((call) => call.message === MEMORY_EVENT.HIGH_USAGE).length,
      1,
    );

    tickInterval();
    assert.equal(
      calls.filter((call) => call.message === MEMORY_EVENT.HIGH_USAGE).length,
      1,
    );

    monitor.stop();
    monitor.stop();
    assert.equal(monitor.isMonitoring, false);
    tickInterval();
    assert.equal(
      calls.filter((call) => call.message === MEMORY_EVENT.HIGH_USAGE).length,
      1,
    );
    heap.restore();
  });

  it("skips a sample when the heap reading is missing", () => {
    const heap = installChromeHeap({ mb: 100 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      highUsageMb: 50,
    });
    enableIntervalTimers();
    monitor.start();
    heap.setThrowOnRead(true);
    assert.doesNotThrow(() => tickInterval());
    assert.equal(calls.length, 0);

    heap.setThrowOnRead(false);
    heap.setMb(100);
    tickInterval();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    heap.restore();
  });

  it("drops snapshots older than the sliding window", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      slidingWindowMs: MINUTE,
      minLeakSamples: 3,
      minWindowCoverageMs: 30_000,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
    });
    enableIntervalTimers();
    monitor.start();

    // t=0: 100MB, t=30s: 200MB — both fall out of a 1-minute window.
    tickInterval();
    clock.add(30_000);
    heap.setMb(200);
    tickInterval();
    clock.add(70_000);
    // Only the latest sample remains; climb inside the retained window.
    heap.setMb(100);
    tickInterval();
    clock.add(30_000);
    heap.setMb(250);
    tickInterval();
    clock.add(30_000);
    heap.setMb(400);
    tickInterval();

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const history = leakLogs[0]?.metadata.heapSizeHistory as HeapHistoryPoint[];
    assert.ok(history.length >= 2);
    assert.ok(Math.max(...history.map((point) => point.minutesAgo)) <= 1);
    heap.restore();
    clock.restore();
  });

  it("logs a leak once with heap history and measure growth", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      getTabCount: () => 3,
    });
    monitor.setMeasures({ cacheEntries: 1000, listeners: 400 });
    enableIntervalTimers();
    monitor.start();

    for (let step = 0; step <= 6; step++) {
      heap.setMb(100 + step * 300);
      if (step === 3) {
        monitor.setMeasures({ cacheEntries: 8000, listeners: 400 });
      }
      tickInterval();
      clock.add(MINUTE);
    }

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    assert.equal(leakLogs[0]?.metadata.tabCount, 3);
    assert.equal(leakLogs[0]?.metadata.tabVisible, true);
    assert.equal(leakLogs[0]?.metadata.usedJSHeapSizeMb, 1600);
    assert.equal(leakLogs[0]?.metadata.sessionDurationMinutes, 5);
    const leak = leakLogs[0]?.metadata.leak as { growthMb: number };
    assert.equal(leak.growthMb, 1500);
    const growth = leakLogs[0]?.metadata.measureGrowth as MeasureGrowth;
    assert.equal(growth.counts.cacheEntries, 7000);
    const history = leakLogs[0]?.metadata.heapSizeHistory as unknown[];
    assert.ok(history.length >= 2);

    tickInterval();
    assert.equal(
      calls.filter((call) => call.message === MEMORY_EVENT.LEAK).length,
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
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    tickInterval();
    const high = calls.filter(
      (call) => call.message === MEMORY_EVENT.HIGH_USAGE,
    );
    assert.equal(high.length, 1);
    assert.equal(high[0]?.metadata.threshold, 2500);
    heap.restore();
  });

  it("retries high-usage report when log throws on the first attempt", () => {
    const heap = installChromeHeap({ mb: 2600 });
    const calls: { message: string; metadata: Record<string, unknown> }[] = [];
    let failNext = true;
    const monitor = new MemoryMonitor({
      measurementIntervalMs: TEST_INTERVAL_MS,
      log(message, metadata) {
        if (failNext) {
          failNext = false;
          throw new Error("sink unavailable");
        }
        calls.push({ message, metadata });
      },
    });
    enableIntervalTimers();
    monitor.start();

    assert.doesNotThrow(() => tickInterval());
    assert.equal(calls.length, 0);

    tickInterval();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    heap.restore();
  });

  it("retries leak report when getTabCount throws on the first attempt", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    let failNext = true;
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      getTabCount() {
        if (failNext) {
          failNext = false;
          throw new Error("tabs unavailable");
        }
        return 2;
      },
    });
    enableIntervalTimers();
    monitor.start();

    for (let step = 0; step <= 5; step++) {
      heap.setMb(100 + step * 300);
      assert.doesNotThrow(() => tickInterval());
      clock.add(MINUTE);
    }

    assert.equal(calls.length, 0);

    tickInterval();
    assert.equal(calls[0]?.message, MEMORY_EVENT.LEAK);
    assert.equal(calls[0]?.metadata.tabCount, 2);
    heap.restore();
    clock.restore();
  });

  it("does not log high usage at the threshold or when reporting is off", () => {
    const heap = installChromeHeap({ mb: 2500 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal(calls.length, 0);
    monitor.stop();

    heap.setMb(3000);
    const quiet = createLogMock();
    const dev = new MemoryMonitor({
      log: quiet.log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      reportHighUsage: false,
    });
    dev.start();
    tickInterval();
    assert.equal(quiet.calls.length, 0);
    heap.restore();
  });

  it("omits tabCount when the caller did not supply getTabCount", () => {
    const heap = installChromeHeap({ mb: 2600 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal("tabCount" in (calls[0]?.metadata ?? {}), false);
    heap.restore();
  });

  it("keeps two measure baselines five minutes apart and caps deltas", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      maxMeasureDeltas: 2,
      slidingWindowMs: 10 * MINUTE,
      minLeakSamples: 3,
      minWindowCoverageMs: 5 * MINUTE,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
    });
    enableIntervalTimers();
    monitor.start();

    monitor.setMeasures({ A: 1, B: 1, C: 1 });
    tickInterval();
    clock.add(4 * MINUTE);
    monitor.setMeasures({ A: 2, B: 2, C: 2 });
    tickInterval();
    clock.add(MINUTE);
    tickInterval();
    clock.add(5 * MINUTE);
    monitor.setMeasures({ A: 102, B: 52, C: 3, D: 1 });
    heap.setMb(400);
    tickInterval();

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const growth = leakLogs[0]?.metadata.measureGrowth as MeasureGrowth;
    assert.deepEqual(growth.counts, { A: 100, B: 50 });
    assert.equal(growth.sinceMinutesAgo, 5);
    heap.restore();
    clock.restore();
  });

  it("omits unchanged measures from growth and treats new keys as growth from zero", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      minLeakSamples: 3,
      minWindowCoverageMs: 5 * MINUTE,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
    });
    enableIntervalTimers();
    monitor.start();

    monitor.setMeasures({ cacheEntries: 10, listeners: 5 });
    tickInterval();
    clock.add(2.5 * MINUTE);
    heap.setMb(200);
    tickInterval();
    clock.add(2.5 * MINUTE);
    monitor.setMeasures({ cacheEntries: 10, listeners: 8, sockets: 4 });
    heap.setMb(400);
    tickInterval();

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const growth = leakLogs[0]?.metadata.measureGrowth as MeasureGrowth;
    assert.deepEqual(growth.counts, { sockets: 4, listeners: 3 });
    assert.equal("cacheEntries" in growth.counts, false);
    heap.restore();
    clock.restore();
  });

  it("downsamples heap history and always keeps the latest sample", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      maxHeapHistoryPoints: 5,
      minLeakSamples: 5,
      minWindowCoverageMs: 5 * MINUTE,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
    });
    enableIntervalTimers();
    monitor.start();

    for (let step = 0; step <= 20; step++) {
      heap.setMb(100 + step * 50);
      tickInterval();
      clock.add(MINUTE);
    }

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const history = leakLogs[0]?.metadata.heapSizeHistory as HeapHistoryPoint[];
    const leak = leakLogs[0]?.metadata.leak as { growthMb: number };
    assert.ok(history.length <= 6);
    assert.equal(history[history.length - 1]?.minutesAgo, 0);
    assert.equal(
      history[history.length - 1]?.usedJSHeapSizeMb,
      leak.growthMb + 100,
    );
    assert.ok((history[0]?.minutesAgo ?? 0) >= (history[1]?.minutesAgo ?? 0));
    heap.restore();
    clock.restore();
  });

  it("reads a hidden tab as not visible", () => {
    const heap = installChromeHeap({ mb: 2600, visibilityState: "hidden" });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal(calls[0]?.metadata.tabVisible, false);
    heap.restore();
  });

  it("treats missing document as not visible without losing the report", () => {
    const heap = installChromeHeap({ mb: 2600 });
    Reflect.deleteProperty(globalThis, "self");
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    assert.equal(calls[0]?.metadata.tabVisible, false);
    heap.restore();
  });

  it("stop keeps one-shot state; reset re-arms alerts for a new session", () => {
    const heap = installChromeHeap({ mb: 2600 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal(calls.length, 1);
    monitor.stop();
    assert.equal(monitor.isMonitoring, false);

    monitor.start();
    tickInterval();
    assert.equal(calls.length, 1);

    monitor.stop();
    monitor.reset();
    assert.equal(monitor.getMemoryInfo().leak, undefined);
    monitor.start();
    tickInterval();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.message, MEMORY_EVENT.HIGH_USAGE);
    heap.restore();
  });

  it("does not treat Object.prototype keys as baseline measure counts", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      minLeakSamples: 3,
      minWindowCoverageMs: 5 * MINUTE,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
    });
    enableIntervalTimers();
    monitor.start();

    monitor.setMeasures({ cacheEntries: 1 });
    tickInterval();
    clock.add(2.5 * MINUTE);
    heap.setMb(200);
    tickInterval();
    clock.add(2.5 * MINUTE);
    monitor.setMeasures({ cacheEntries: 1, toString: 4 });
    heap.setMb(400);
    tickInterval();

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const growth = leakLogs[0]?.metadata.measureGrowth as MeasureGrowth;
    assert.equal(growth.counts.toString, 4);
    heap.restore();
    clock.restore();
  });

  it("falls back to Date.now when performance.now is unavailable", () => {
    const clock = installClock(3 * MINUTE);
    const memory = { usedJSHeapSize: 2600 * MB };
    Object.defineProperty(globalThis, "performance", {
      value: { memory },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: { performance: { memory } },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "self", {
      value: { document: { visibilityState: "visible" } },
      configurable: true,
      writable: true,
    });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    assert.equal(calls[0]?.metadata.sessionDurationMinutes, 3);

    Object.defineProperty(globalThis, "performance", {
      value: {
        memory,
        now() {
          throw new Error("now failed");
        },
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: { performance: globalThis.performance },
      configurable: true,
      writable: true,
    });
    monitor.reset();
    tickInterval();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.metadata.sessionDurationMinutes, 3);
    clock.restore();
  });

  it("evicts snapshots after the clock jumps backward within the window math", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(10 * MINUTE);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      slidingWindowMs: MINUTE,
      minLeakSamples: 3,
      minWindowCoverageMs: 30_000,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
    });
    enableIntervalTimers();
    monitor.start();

    tickInterval();
    clock.set(0);
    heap.setMb(200);
    tickInterval();
    clock.add(30_000);
    heap.setMb(350);
    tickInterval();
    clock.add(30_000);
    heap.setMb(500);
    tickInterval();

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const history = leakLogs[0]?.metadata.heapSizeHistory as HeapHistoryPoint[];
    assert.ok(history.every((point) => point.minutesAgo >= 0));
    heap.restore();
    clock.restore();
  });
});
