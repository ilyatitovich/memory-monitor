import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { detectMemoryLeak, MemoryMonitor } from "../index.ts";
import type { HeapSnapshot } from "../index.ts";
import {
  createLogMock,
  installChromeHeap,
  installClock,
  resetGlobals,
} from "./test-helpers.ts";

const MINUTE = 60_000;

function snapshots(points: [number, number][]): HeapSnapshot[] {
  return points.map(([minutes, mb]) => ({
    timestamp: minutes * MINUTE,
    usedJSHeapSizeMb: mb,
  }));
}

describe("real-world memory sessions", { concurrency: false }, () => {
  afterEach(resetGlobals);
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
    const monitor = new MemoryMonitor({
      log,
      getTabCount: () => 4,
    });

    const live = { cacheEntries: 8_000, listeners: 20_000 };
    monitor.setMeasures(live);

    for (let minute = 0; minute <= 8; minute++) {
      live.cacheEntries = 8_000 + minute * 6_000;
      live.listeners = 20_000 + minute * 2_000;
      monitor.setMeasures({ ...live });
      heap.setMb(400 + minute * 280);
      monitor.runMemoryCheck();
      clock.add(MINUTE);
    }

    const report = calls.find(
      (call) => call.message === "Detected potential memory leak",
    );
    assert.ok(report);
    const growth = report.metadata.measureGrowth as {
      counts: Record<string, number>;
    };
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
    const monitor = new MemoryMonitor({
      log,
      getTabCount: () => 8,
    });
    const measures = { cacheEntries: 4200, listeners: 18_000 };
    monitor.setMeasures(measures);
    monitor.runMemoryCheck();

    assert.equal(calls[0]?.message, "High memory usage");
    assert.equal(calls[0]?.metadata.tabVisible, false);
    assert.equal(calls[0]?.metadata.tabCount, 8);
    assert.deepEqual(calls[0]?.metadata.measures, measures);
    heap.restore();
  });

  it("crossing 2.5GB fires high usage once while the user keeps navigating", () => {
    const heap = installChromeHeap({ mb: 2400 });
    const clock = installClock(0);
    const { log, calls } = createLogMock();
    const monitor = new MemoryMonitor({ log });

    monitor.runMemoryCheck();
    heap.setMb(2510);
    clock.add(10_000);
    monitor.runMemoryCheck();
    heap.setMb(2700);
    clock.add(10_000);
    monitor.runMemoryCheck();

    assert.equal(
      calls.filter((call) => call.message === "High memory usage").length,
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
      reportHighUsage: false,
    });
    monitor.runMemoryCheck();
    assert.equal(calls.length, 0);
    heap.restore();
  });

  it("only the last 10 minutes of heap stay in the window during an overnight tab", () => {
    const heap = installChromeHeap({ mb: 500 });
    const clock = installClock(0);
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({ log });

    for (let minute = 0; minute <= 15; minute++) {
      heap.setMb(500 + minute);
      monitor.runMemoryCheck();
      clock.add(MINUTE);
    }

    const oldest = monitor.snapshots[0];
    const newest = monitor.snapshots[monitor.snapshots.length - 1];
    assert.ok(oldest && newest);
    assert.ok(newest.timestamp - oldest.timestamp <= 10 * MINUTE);
    heap.restore();
    clock.restore();
  });

  it("dozens of measure keys only ship the largest deltas", () => {
    const heap = installChromeHeap({ mb: 100 });
    const clock = installClock(0);
    const { log } = createLogMock();
    const monitor = new MemoryMonitor({
      log,
      maxMeasureDeltas: 3,
    });

    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let index = 0; index < 30; index++) {
      const name = `metric${index}`;
      before[name] = 10;
      after[name] = 10 + index;
    }
    monitor.setMeasures(before);
    monitor.runMemoryCheck();
    clock.add(5 * MINUTE);
    monitor.setMeasures(after);
    monitor.runMemoryCheck();

    const growth = monitor.computeMeasureGrowth(clock.value(), after);
    assert.deepEqual(growth?.counts, {
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
      getTabCount: () => 1,
    });
    monitor.setMeasures({ cacheEntries: 4200, listeners: 18_000 });

    for (let minute = 0; minute <= 6; minute++) {
      heap.setMb(100 + minute * 450);
      monitor.runMemoryCheck();
      clock.add(MINUTE);
    }

    const messages = calls.map((call) => call.message);
    assert.ok(messages.includes("Detected potential memory leak"));
    assert.ok(messages.includes("High memory usage"));
    heap.restore();
    clock.restore();
  });
});
