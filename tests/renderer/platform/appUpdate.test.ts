import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppUpdatePort } from "@/shared/platform/tauri/feature-ports/appUpdate";
import { createBrowserFeaturePorts } from "@/shared/platform/browser/features";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("application update narrow native port", () => {
  it("checks through application commands and installs the exact reviewed version", async () => {
    const port = createAppUpdatePort();
    const reply = {
      currentVersion: "0.4.10",
      update: { version: "0.4.11", notes: "修复", date: null },
    };
    invoke.mockResolvedValue(reply);
    await expect(port.check()).resolves.toEqual(reply);
    expect(invoke).toHaveBeenLastCalledWith("check_app_update");
    invoke.mockResolvedValue(undefined);
    await port.install("0.4.11");
    expect(invoke).toHaveBeenLastCalledWith("install_app_update", {
      version: "0.4.11",
    });
    invoke.mockResolvedValue({ currentVersion: "0.4.10", update: null });
    await expect(port.check()).resolves.toEqual({
      currentVersion: "0.4.10",
      update: null,
    });
  });

  it("rejects malformed, missing and excess reply fields and invalid versions", async () => {
    const port = createAppUpdatePort();
    for (const reply of [
      null,
      {},
      { currentVersion: "not-version", update: null },
      { currentVersion: "0.4.10", update: null, extra: true },
      {
        currentVersion: "0.4.10",
        update: { version: "0.4.11", notes: 4, date: null },
      },
      { currentVersion: "0.4.10", update: { version: "0.4.11", notes: null } },
    ]) {
      invoke.mockResolvedValue(reply);
      await expect(port.check()).rejects.toThrow("数据无效");
    }
    invoke.mockClear();
    await expect(port.install("invalid")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("decodes progress events, ignores invalid payloads and returns the unlisten function", async () => {
    const unlisten = vi.fn();
    let event!: (value: { payload: unknown }) => void;
    listen.mockImplementation(async (_name, callback) => {
      event = callback;
      return unlisten;
    });
    const callback = vi.fn();
    const release = await createAppUpdatePort().subscribeProgress(callback);
    expect(listen).toHaveBeenCalledWith(
      "app-update-progress",
      expect.any(Function),
    );
    event({ payload: { downloaded: 1024, total: null, phase: "downloading" } });
    expect(callback).toHaveBeenCalledWith({
      downloaded: 1024,
      total: null,
      phase: "downloading",
    });
    event({ payload: { downloaded: 2048, total: 2048, phase: "installing" } });
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    for (const payload of [
      null,
      { downloaded: -1, total: 10, phase: "downloading" },
      { downloaded: 0, total: Infinity, phase: "downloading" },
      { downloaded: 1, total: null, phase: "unknown" },
    ])
      event({ payload });
    expect(callback).toHaveBeenCalledTimes(2);
    release();
    expect(unlisten).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("offers controlled browser unavailability and a harmless subscription", async () => {
    const port = createBrowserFeaturePorts().appUpdate;
    await expect(port.check()).rejects.toThrow("桌面应用");
    await expect(port.install("0.4.11")).rejects.toThrow("桌面应用");
    const callback = vi.fn();
    const release = await port.subscribeProgress(callback);
    release();
    expect(callback).not.toHaveBeenCalled();
  });
});
