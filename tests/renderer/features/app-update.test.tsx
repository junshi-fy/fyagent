import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateCheck,
  AppUpdatePort,
  AppUpdateProgress,
} from "@/shared/features/app-update/types";
import {
  APP_UPDATE_CHECK_INTERVAL,
  APP_UPDATE_STARTUP_DELAY,
  SKIPPED_APP_UPDATE_KEY,
  useAppUpdateController,
} from "@/shared/features/app-update/useAppUpdateController";

const reply = (version = "0.4.11"): AppUpdateCheck => ({
  currentVersion: "0.4.10",
  update: { version, notes: "修复启动问题", date: null },
});
const getVersion = async () => "0.4.10";

function setup() {
  const check = vi.fn(async () => reply());
  const install = vi.fn<(version: string) => Promise<void>>(
    async () => undefined,
  );
  const unlisten = vi.fn();
  let listener: ((value: AppUpdateProgress) => void) | undefined;
  const port: AppUpdatePort = {
    check,
    install,
    subscribeProgress: vi.fn(async (callback) => {
      listener = callback;
      return unlisten;
    }),
  };
  const hook = renderHook(() => useAppUpdateController(port, getVersion));
  return {
    ...hook,
    port,
    check,
    install,
    unlisten,
    emit: (value: AppUpdateProgress) => listener?.(value),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("application update lifetime", () => {
  it("waits eight seconds and checks at most once per 24 hours", async () => {
    const state = setup();
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_STARTUP_DELAY - 1));
    expect(state.check).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(state.result.current.hasUpdate).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL - 1));
    expect(state.check).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(state.check).toHaveBeenCalledTimes(2);
    expect(state.install).not.toHaveBeenCalled();
    expect(state.port.subscribeProgress).not.toHaveBeenCalled();
  });

  it("keeps automatic failures silent and throttles failed attempts", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const state = setup();
    state.check.mockRejectedValue(new Error("网络不可用"));
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_STARTUP_DELAY));
    expect(state.result.current.error).toBeNull();
    expect(state.result.current.hasUpdate).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL - 1));
    expect(state.check).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(state.check).toHaveBeenCalledTimes(2);
    await act(() => state.result.current.check());
    expect(state.result.current.error).toBe("网络不可用");
  });

  it("persists an exact skipped version, keeps it visible manually and marks higher versions", async () => {
    const first = setup();
    await act(() => first.result.current.check());
    act(() => first.result.current.skipVersion());
    expect(localStorage.getItem(SKIPPED_APP_UPDATE_KEY)).toBe("0.4.11");
    expect(first.result.current.hasUpdate).toBe(false);
    first.unmount();
    const next = setup();
    await act(() => next.result.current.check());
    expect(next.result.current.update?.version).toBe("0.4.11");
    expect(next.result.current.isSkipped).toBe(true);
    expect(next.result.current.hasUpdate).toBe(false);
    next.check.mockResolvedValue(reply("0.4.12"));
    await act(() => next.result.current.check());
    expect(next.result.current.hasUpdate).toBe(true);
    act(() => next.result.current.skipVersion());
    act(() => next.result.current.clearSkippedVersion());
    expect(localStorage.getItem(SKIPPED_APP_UPDATE_KEY)).toBeNull();
    expect(next.result.current.hasUpdate).toBe(true);
  });

  it("manual checks postpone automatic checks and concurrent requests do not duplicate", async () => {
    const state = setup();
    await act(() => state.result.current.check());
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_STARTUP_DELAY));
    expect(state.check).toHaveBeenCalledTimes(1);
    await act(() =>
      vi.advanceTimersByTimeAsync(
        APP_UPDATE_CHECK_INTERVAL - APP_UPDATE_STARTUP_DELAY,
      ),
    );
    expect(state.check).toHaveBeenCalledTimes(2);
    let resolve!: (value: AppUpdateCheck) => void;
    state.check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = state.result.current.check();
    });
    await act(() => state.result.current.check());
    expect(state.check).toHaveBeenCalledTimes(3);
    await act(async () => {
      resolve(reply());
      await pending;
    });
  });

  it("StrictMode schedules one check and unmount cancels timers", async () => {
    const check = vi.fn(async () => reply());
    const port: AppUpdatePort = {
      check,
      install: vi.fn(),
      subscribeProgress: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const hook = renderHook(() => useAppUpdateController(port, getVersion), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_STARTUP_DELAY));
    expect(check).toHaveBeenCalledOnce();
    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL));
    expect(check).toHaveBeenCalledOnce();
  });

  it("installs only on demand, streams progress, cleans listeners and unlocks after failure", async () => {
    const state = setup();
    await act(() => state.result.current.check());
    let reject!: (error: Error) => void;
    state.install.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = state.result.current.install();
      await Promise.resolve();
    });
    expect(state.install).toHaveBeenCalledWith("0.4.11");
    act(() => state.emit({ downloaded: 12, total: 24, phase: "downloading" }));
    expect(state.result.current.progress?.downloaded).toBe(12);
    await act(() => state.result.current.install());
    expect(state.install).toHaveBeenCalledOnce();
    await act(async () => {
      reject(new Error("后台任务正在安装，请稍后更新"));
      await pending;
    });
    expect(state.unlisten).toHaveBeenCalledOnce();
    expect(state.result.current.progress).toBeNull();
    expect(state.result.current.error).toContain("后台任务");
    state.install.mockResolvedValue(undefined);
    await act(() => state.result.current.install());
    expect(state.install).toHaveBeenCalledTimes(2);
    expect(state.result.current.progress?.phase).toBe("installing");
  });

  it("releases progress immediately when an in-flight install unmounts", async () => {
    const state = setup();
    await act(() => state.result.current.check());
    let finish!: () => void;
    state.install.mockImplementation(
      () =>
        new Promise((done) => {
          finish = () => done(undefined);
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = state.result.current.install();
      await Promise.resolve();
    });
    state.unmount();
    expect(state.unlisten).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await pending;
    });
    expect(state.unlisten).toHaveBeenCalledOnce();
  });

  it("releases a delayed subscription after unmount without starting an install", async () => {
    const state = setup();
    await act(() => state.result.current.check());
    let subscribe!: (release: () => void) => void;
    state.port.subscribeProgress = vi.fn(
      () =>
        new Promise<() => void>((done) => {
          subscribe = done;
        }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = state.result.current.install();
    });
    state.unmount();
    await act(async () => {
      subscribe(state.unlisten);
      await pending;
    });
    expect(state.unlisten).toHaveBeenCalledOnce();
    expect(state.install).not.toHaveBeenCalled();
  });
});
