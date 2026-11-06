import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { detectMemoryLeak, MEMORY_EVENT, MemoryMonitor } from "../index.ts";
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

function snapshots(points: [number, number][]): HeapSnapshot[] {
  return points.map(([minutes, mb]) => ({
    timestamp: minutes * MINUTE,
    usedJSHeapSizeMb: mb,
  }));
}

describe("real-world memory sessions", { concurrency: false }, () => {
  afterEach(() => {
    mock.timers.reset();
    resetGlobals();
  });

  it("a large workspace that hydrates then GCs is not a leak", () => {
    // Bootstrap pulls ~1.7GB into heap, then idle GC flattens it.
    const leak = detectMemoryLeak(
      snapshots([
        [0, 180],
        [1, 900],
        [2, 1500],
        [3, 1720],
        [4, 1680],
        [5, 1640],
        [6, 1610],
      ]),
    );
    assert.equal(leak, undefined);
  });

  it("GC sawtooth after a one-time jump is not a leak", () => {
    const leak = detectMemoryLeak(
      snapshots([
        [0, 200],
        [1, 1800],
        [2, 900],
        [3, 1700],
        [4, 850],
        [5, 1650],
        [6, 800],
      ]),
    );
    assert.equal(leak, undefined);
  });

  it("a growing cache reports the largest measure delta on a leak", () => {
    const heap = installChromeHeap({ mb: 400 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const live = { cacheEntries: 8_000, listeners: 20_000 };
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      getTabCount: () => 4,
      getMeasures: () => live,
    });
    enableIntervalTimers();
    monitor.start();

    for (let minute = 0; minute <= 8; minute++) {
      live.cacheEntries = 8_000 + minute * 6_000;
      live.listeners = 20_000 + minute * 2_000;
      heap.setMb(400 + minute * 280);
      tickInterval();
      clock.add(MINUTE);
    }

    const report = calls.find((call) => call.message === MEMORY_EVENT.LEAK);
    assert.ok(report);
    const growth = report.metadata.measureGrowth as MeasureGrowth;
    const cacheDelta = growth.counts.cacheEntries;
    const listenerDelta = growth.counts.listeners;
    assert.ok(cacheDelta !== undefined && listenerDelta !== undefined);
    assert.ok(cacheDelta > listenerDelta);
    assert.equal(report.metadata.tabCount, 4);
    heap.restore();
    clock.restore();
  });

  it("a background tab still reports visibility and tab count", () => {
    const heap = installChromeHeap({
      mb: 2600,
      visibilityState: "hidden",
    });
    const { log, calls } = createLogMock();
    const measures = { cacheEntries: 4200, listeners: 18_000 };
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      getTabCount: () => 8,
      getMeasures: () => measures,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();

    assert.equal(calls[0]?.message, MEMORY_EVENT.HIGH_USAGE);
    assert.equal(calls[0]?.metadata.tabVisible, false);
    assert.equal(calls[0]?.metadata.tabCount, 8);
    assert.deepEqual(calls[0]?.metadata.measures, measures);
    heap.restore();
  });

  it("crossing 2.5GB fires high usage once while the user keeps navigating", () => {
    const heap = installChromeHeap({ mb: 2400 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();

    tickInterval();
    heap.setMb(2510);
    clock.add(10_000);
    tickInterval();
    heap.setMb(2700);
    clock.add(10_000);
    tickInterval();

    assert.equal(
      calls.filter((call) => call.message === MEMORY_EVENT.HIGH_USAGE).length,
      1,
    );
    heap.restore();
    clock.restore();
  });

  it("a development-style session can mute high-usage reports", () => {
    const heap = installChromeHeap({ mb: 4000 });
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      reportHighUsage: false,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    assert.equal(calls.length, 0);
    heap.restore();
  });

  it("only the last 10 minutes of heap stay in the window during an overnight tab", () => {
    const heap = installChromeHeap({ mb: 500 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
    });
    enableIntervalTimers();
    monitor.start();

    for (let minute = 0; minute <= 15; minute++) {
      heap.setMb(100 + minute * 200);
      tickInterval();
      clock.add(MINUTE);
    }

    const report = calls.find((call) => call.message === MEMORY_EVENT.LEAK);
    assert.ok(report);
    const history = report.metadata.heapSizeHistory as HeapHistoryPoint[];
    assert.ok(history.length >= 2);
    const oldestMinutesAgo = Math.max(
      ...history.map((point) => point.minutesAgo),
    );
    assert.ok(oldestMinutesAgo <= 10);
    heap.restore();
    clock.restore();
  });

  it("dozens of measure keys only ship the largest deltas", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let index = 0; index < 30; index++) {
      const name = `metric${index}`;
      before[name] = 10;
      after[name] = 10 + index;
    }
    let measures = before;
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      maxMeasureDeltas: 3,
      minLeakSamples: 3,
      minWindowCoverageMs: 5 * MINUTE,
      leakGrowthMb: 200,
      sustainedGrowthMbPerSecond: 0,
      getMeasures: () => measures,
    });
    enableIntervalTimers();
    monitor.start();
    tickInterval();
    clock.add(2.5 * MINUTE);
    heap.setMb(200);
    tickInterval();
    clock.add(2.5 * MINUTE);
    measures = after;
    heap.setMb(400);
    tickInterval();

    const leakLogs = calls.filter(
      (call) => call.message === MEMORY_EVENT.LEAK,
    );
    assert.equal(leakLogs.length, 1);
    const growth = leakLogs[0]?.metadata.measureGrowth as MeasureGrowth;
    assert.deepEqual(growth.counts, {
      metric29: 29,
      metric28: 28,
      metric27: 27,
    });
    heap.restore();
    clock.restore();
  });

  it("Firefox without performance.memory never starts sampling", () => {
    Object.defineProperty(globalThis, "window", {
      value: { performance: { now: () => 0 } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "performance", {
      value: { now: () => 0 },
      configurable: true,
    });
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });
    monitor.start();
    assert.equal(monitor.isMonitoring, false);
    assert.deepEqual(monitor.getMemoryInfo(), {
      memoryUsage: undefined,
      leak: undefined,
    });
    Reflect.deleteProperty(globalThis, "window");
  });

  it("a leak and a 2.5GB heap in the same session send both reports", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      measurementIntervalMs: TEST_INTERVAL_MS,
      getTabCount: () => 1,
      getMeasures: () => ({ cacheEntries: 4200, listeners: 18_000 }),
    });
    enableIntervalTimers();
    monitor.start();

    for (let minute = 0; minute <= 6; minute++) {
      heap.setMb(100 + minute * 450);
      tickInterval();
      clock.add(MINUTE);
    }

    const messages = calls.map((call) => call.message);
    assert.ok(messages.includes(MEMORY_EVENT.LEAK));
    assert.ok(messages.includes(MEMORY_EVENT.HIGH_USAGE));
    heap.restore();
    clock.restore();
  });
});
