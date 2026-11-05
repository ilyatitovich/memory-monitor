import { mock } from "node:test";
import type { LogFn } from "../index.ts";

const MB = 1024 * 1024;

const originalDateNow = Date.now;
const originalGlobals = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  performance: Object.getOwnPropertyDescriptor(globalThis, "performance"),
  self: Object.getOwnPropertyDescriptor(globalThis, "self"),
};

export function resetGlobals(): void {
  Date.now = originalDateNow;
  restoreDescriptor("window", originalGlobals.window);
  restoreDescriptor("performance", originalGlobals.performance);
  restoreDescriptor("self", originalGlobals.self);
}

export type LogCall = {
  message: string;
  metadata: Record<string, unknown>;
};

/** Captures every `log(message, metadata)` call the monitor makes. */
export function createLogMock(): { log: LogFn; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const log: LogFn = mock.fn(
    (message: string, metadata: Record<string, unknown>): void => {
      calls.push({ message, metadata });
    },
  );
  return { log, calls };
}

export function installClock(start = 0): {
  value(): number;
  set(ms: number): void;
  add(ms: number): void;
  restore(): void;
} {
  let now = start;
  const original = Date.now;
  Date.now = (): number => now;
  return {
    value(): number {
      return now;
    },
    set(ms: number): void {
      now = ms;
    },
    add(ms: number): void {
      now += ms;
    },
    restore(): void {
      Date.now = original;
    },
  };
}

type HeapOptions = {
  mb?: number;
  bytes?: number;
  visibilityState?: string;
  throwOnMemory?: boolean;
};

/**
 * Chrome's `performance.memory` is not in Node. Tests install a stand-in so
 * `usedJsHeapSizeMb` and `isSupported` see the same shape the browser does.
 */
export function installChromeHeap(options: HeapOptions = {}): {
  setMb(mb: number): void;
  setBytes(next: number): void;
  setVisibility(state: string): void;
  restore(): void;
} {
  let bytes =
    options.bytes ?? (options.mb !== undefined ? options.mb * MB : 100 * MB);

  const memory = {
    get usedJSHeapSize(): number {
      if (options.throwOnMemory) throw new Error("memory probe failed");
      return bytes;
    },
  };

  const performanceLike = {
    now(): number {
      return 90_000;
    },
    memory,
  };

  const document = { visibilityState: options.visibilityState ?? "visible" };

  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    performance: Object.getOwnPropertyDescriptor(globalThis, "performance"),
    self: Object.getOwnPropertyDescriptor(globalThis, "self"),
  };

  Object.defineProperty(globalThis, "performance", {
    value: performanceLike,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { performance: performanceLike },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "self", {
    value: { document },
    configurable: true,
    writable: true,
  });

  return {
    setMb(mb: number): void {
      bytes = mb * MB;
    },
    setBytes(next: number): void {
      bytes = next;
    },
    setVisibility(state: string): void {
      document.visibilityState = state;
    },
    restore(): void {
      restoreDescriptor("window", previous.window);
      restoreDescriptor("performance", previous.performance);
      restoreDescriptor("self", previous.self);
    },
  };
}

function restoreDescriptor(
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, key);
}
