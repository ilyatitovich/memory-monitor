const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Log message strings emitted by {@link MemoryMonitor}. */
export const MEMORY_EVENT = {
  LEAK: "Detected potential memory leak",
  HIGH_USAGE: "High memory usage",
} as const;

export type MemoryEventMessage =
  (typeof MEMORY_EVENT)[keyof typeof MEMORY_EVENT];

export interface HeapSnapshot {
  timestamp: number;
  usedJSHeapSizeMb: number;
}

export interface HeapHistoryPoint {
  minutesAgo: number;
  usedJSHeapSizeMb: number;
}

export interface MemoryLeak {
  growthMb: number;
  growthRatePerSecondTrend: number;
  windowCoverageMinutes: number;
}

export type LogFn = (
  message: string,
  metadata: Record<string, unknown>,
) => void;

export interface Settings {
  highUsageMb: number;
  leakGrowthMb: number;
  sustainedGrowthMbPerSecond: number;
  measurementIntervalMs: number;
  slidingWindowMs: number;
  minWindowCoverageMs: number;
  minLeakSamples: number;
  maxMeasureDeltas: number;
  maxHeapHistoryPoints: number;
  reportHighUsage: boolean;
}

export interface MemoryMonitorOptions extends Partial<Settings> {
  log: LogFn;
  getTabCount?: () => number;
}

/** Shared fields attached to every monitor log event. */
export interface ReportMetadata {
  usedJSHeapSizeMb: number;
  sessionDurationMinutes: number;
  tabVisible: boolean;
  measures: Record<string, number>;
  tabCount?: number;
}

/** Largest measure deltas since the oldest retained baseline. */
export interface MeasureGrowth {
  sinceMinutesAgo: number;
  counts: Record<string, number>;
}

/** Latest heap reading and leak detected for the current window, if any. */
export interface MemoryInfo {
  memoryUsage: number | undefined;
  leak: MemoryLeak | undefined;
}

interface MeasureBaseline {
  timestamp: number;
  counts: Record<string, number>;
}

const defaults: Settings = {
  highUsageMb: 2500,
  leakGrowthMb: 1500,
  sustainedGrowthMbPerSecond: 1,
  measurementIntervalMs: 10 * SECOND,
  slidingWindowMs: 10 * MINUTE,
  minWindowCoverageMs: 5 * MINUTE,
  minLeakSamples: 5,
  maxMeasureDeltas: 20,
  maxHeapHistoryPoints: 20,
  reportHighUsage: true,
};

/**
 * Chrome heap size in megabytes, rounded to the nearest megabyte.
 * Returns nothing where "performance.memory" is unavailable.
 */
export function usedJsHeapSizeMb(): number | undefined {
  try {
    const memory: unknown = Reflect.get(
      window?.performance ?? {},
      "memory",
    );
    if (
      memory !== null &&
      typeof memory === "object" &&
      "usedJSHeapSize" in memory &&
      typeof memory.usedJSHeapSize === "number"
    ) {
      return Math.round(
        Math.round((memory.usedJSHeapSize / 1024 / 1024) * 100) / 100,
      );
    }
  } catch {}
  return undefined;
}

/** Least-squares slope of heap samples, in megabytes per second. */
function heapGrowthMbPerSecond(snapshots: HeapSnapshot[]): number {
  const count = snapshots.length;
  if (count < 2) return 0;

  const origin = snapshots[0]?.timestamp;
  /* c8 ignore next */
  if (origin === undefined) return 0;

  const points = snapshots.map((snapshot) => ({
    x: (snapshot.timestamp - origin) / 1000,
    y: snapshot.usedJSHeapSizeMb,
  }));

  const sumX = points.reduce((total, point) => total + point.x, 0);
  const sumY = points.reduce((total, point) => total + point.y, 0);
  const sumXY = points.reduce((total, point) => total + point.x * point.y, 0);
  const denominator =
    count * points.reduce((total, point) => total + point.x * point.x, 0) -
    sumX * sumX;

  if (denominator === 0) return 0;
  return (count * sumXY - sumX * sumY) / denominator;
}

/**
 * A leak is 1500MB of growth across at least 5 minutes, with the later half
 * still climbing faster than 1MB per second. Fewer than five samples returns nothing.
 */
export function detectMemoryLeak(
  snapshots: HeapSnapshot[],
  settings: Partial<Settings> = {},
): MemoryLeak | undefined {
  const {
    minLeakSamples,
    minWindowCoverageMs,
    leakGrowthMb,
    sustainedGrowthMbPerSecond,
  } = { ...defaults, ...settings };

  if (snapshots.length < minLeakSamples) return;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (!first || !last) return;
  const coveredMs = last.timestamp - first.timestamp;

  if (coveredMs < minWindowCoverageMs) return;

  const growthMb = last.usedJSHeapSizeMb - first.usedJSHeapSizeMb;
  const laterHalf = snapshots.filter(
    (snapshot) => snapshot.timestamp >= last.timestamp - coveredMs / 2,
  );
  const growthRate = heapGrowthMbPerSecond(laterHalf);
  if (growthMb < leakGrowthMb || growthRate <= sustainedGrowthMbPerSecond)
    return;
  return {
    growthMb,
    growthRatePerSecondTrend: Math.round(growthRate * 100) / 100,
    windowCoverageMinutes: Math.round(coveredMs / MINUTE),
  };
}

function isSupported(): boolean {
  return usedJsHeapSizeMb() !== undefined;
}

/** Samples the JS heap and reports one leak or high-usage event per session. */
export class MemoryMonitor {
  private log: LogFn;
  private getTabCount: (() => number) | undefined;
  private settings: Settings;
  private measures: Record<string, number> = {};
  private monitoring = false;
  private snapshots: HeapSnapshot[] = [];
  private measureBaselines: MeasureBaseline[] = [];
  private hasWarnedAboutLeak = false;
  private hasWarnedAboutUsage = false;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private potentialLeak: MemoryLeak | undefined;

  constructor(options: MemoryMonitorOptions) {
    const { log, getTabCount, ...settings } = options;
    this.log = log;
    this.getTabCount = getTabCount;
    this.settings = { ...defaults, ...settings };
  }

  /** Whether the sampling interval is currently running. */
  get isMonitoring(): boolean {
    return this.monitoring;
  }

  /** Replace the measured counts included in leak reports. */
  setMeasures(measures: Record<string, number>): void {
    this.measures = measures;
  }

  /** Start sampling. Later calls are no-ops while already running. */
  start(): void {
    if (!isSupported() || this.monitoring) return;

    this.monitoring = true;
    this.intervalId = setInterval(
      () => this.runMemoryCheck(),
      this.settings.measurementIntervalMs,
    );
  }

  /** Stop sampling. */
  stop(): void {
    if (!this.monitoring) return;
    clearInterval(this.intervalId);
    this.intervalId = undefined;
    this.monitoring = false;
  }

  /** Latest heap reading and the leak detected for the current window, if any. */
  getMemoryInfo(): MemoryInfo {
    return {
      memoryUsage: usedJsHeapSizeMb(),
      leak: this.potentialLeak,
    };
  }

  /** Record one sample, drop readings older than the sliding window, and report the first leak or high-usage event. */
  private runMemoryCheck(): void {
    try {
      const usedMb = usedJsHeapSizeMb();
      if (usedMb === undefined) return;

      const now = Date.now();
      this.snapshots.push({ timestamp: now, usedJSHeapSizeMb: usedMb });

      while (
        this.snapshots[0] !== undefined &&
        this.snapshots[0].timestamp < now - this.settings.slidingWindowMs
      ) {
        this.snapshots.shift();
      }

      this.updateMeasureBaseline(now);
      this.potentialLeak = detectMemoryLeak(this.snapshots, this.settings);

      if (this.potentialLeak && !this.hasWarnedAboutLeak) {
        const metadata = this.reportMetadata(usedMb);

        this.log(MEMORY_EVENT.LEAK, {
          ...metadata,
          leak: this.potentialLeak,
          heapSizeHistory: this.serializeHeapHistory(now),
          measureGrowth: this.computeMeasureGrowth(now, metadata.measures),
        });
        this.hasWarnedAboutLeak = true;
      }
      if (
        usedMb > this.settings.highUsageMb &&
        !this.hasWarnedAboutUsage &&
        this.settings.reportHighUsage
      ) {
        this.log(MEMORY_EVENT.HIGH_USAGE, {
          threshold: this.settings.highUsageMb,
          ...this.reportMetadata(usedMb),
        });
        this.hasWarnedAboutUsage = true;
      }
    } catch {}
  }

  private reportMetadata(usedMb: number): ReportMetadata {
    const metadata: ReportMetadata = {
      usedJSHeapSizeMb: usedMb,
      sessionDurationMinutes: Math.round(performance.now() / MINUTE),
      tabVisible: self.document.visibilityState === "visible",
      measures: this.measures,
    };

    if (this.getTabCount) {
      metadata.tabCount = this.getTabCount();
    }

    return metadata;
  }

  /** Keep two measure samples, at least half a sliding window apart. */
  private updateMeasureBaseline(now: number): void {
    const latest = this.measureBaselines[this.measureBaselines.length - 1];

    if (latest && now - latest.timestamp < this.settings.slidingWindowMs / 2) {
      return;
    }

    this.measureBaselines.push({
      timestamp: now,
      counts: { ...this.measures },
    });

    if (this.measureBaselines.length > 2) {
      this.measureBaselines.shift();
    }
  }

  /** Largest measure changes since the oldest baseline, at most `maxMeasureDeltas`. */
  private computeMeasureGrowth(
    now: number,
    counts: Record<string, number>,
  ): MeasureGrowth | undefined {
    const baseline = this.measureBaselines[0];
    /* c8 ignore next */
    if (!baseline) return;
    const deltas: [string, number][] = [];
    for (const [name, count] of Object.entries(counts)) {
      const delta = count - (baseline.counts[name] ?? 0);
      if (delta !== 0) deltas.push([name, delta]);
    }
    deltas.sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]));
    return {
      sinceMinutesAgo: Math.round((now - baseline.timestamp) / MINUTE),
      counts: Object.fromEntries(
        deltas.slice(0, this.settings.maxMeasureDeltas),
      ),
    };
  }

  /** About `maxHeapHistoryPoints` from the current window, oldest first, always including the latest sample. */
  private serializeHeapHistory(now: number): HeapHistoryPoint[] {
    const stride = Math.max(
      1,
      Math.ceil(this.snapshots.length / this.settings.maxHeapHistoryPoints),
    );
    return this.snapshots
      .filter(
        (_, index) =>
          index % stride === 0 || index === this.snapshots.length - 1,
      )
      .map((snapshot) => ({
        minutesAgo: Math.round((now - snapshot.timestamp) / MINUTE),
        usedJSHeapSizeMb: snapshot.usedJSHeapSizeMb,
      }));
  }
}
