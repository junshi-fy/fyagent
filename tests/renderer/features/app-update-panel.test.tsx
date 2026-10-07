import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdatePanel } from "@/shared/features/app-update/AppUpdatePanel";
import { AppUpdateProvider } from "@/shared/features/app-update/provider";
import type {
  AppUpdateCheck,
  AppUpdateProgress,
} from "@/shared/features/app-update/types";
import { SKIPPED_APP_UPDATE_KEY } from "@/shared/features/app-update/useAppUpdateController";
import { FeatureProvider } from "@/shared/features/provider";
import { createBrowserFeaturePorts } from "@/shared/platform/browser/features";

const update: AppUpdateCheck = {
  currentVersion: "0.4.10",
  update: {
    version: "0.4.11",
    notes: "修复启动\n优化稳定性",
    date: "2026-10-08",
  },
};

function setup(reply: AppUpdateCheck = update) {
  const ports = createBrowserFeaturePorts();
  const check = vi.fn(async () => reply);
  const install = vi.fn<(version: string) => Promise<void>>(
    async () => undefined,
  );
  const openExternal = vi.fn<(url: string) => Promise<void>>(
    async () => undefined,
  );
  const unlisten = vi.fn();
  let listener: ((progress: AppUpdateProgress) => void) | undefined;
  ports.appUpdate = {
    check,
    install,
    subscribeProgress: async (callback) => {
      listener = callback;
      return unlisten;
    },
  };
  ports.settings.getAppVersion = async () => "0.4.10";
  ports.settings.openExternal = openExternal;
  const view = render(
    <FeatureProvider ports={ports}>
      <AppUpdateProvider>
        <AppUpdatePanel />
      </AppUpdateProvider>
    </FeatureProvider>,
  );
  return {
    ...view,
    check,
    install,
    openExternal,
    unlisten,
    emit: (progress: AppUpdateProgress) => listener?.(progress),
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("application update panel", () => {
  it("shows the current version and only checks on request", async () => {
    const state = setup();
    expect(await screen.findByText("当前版本：0.4.10")).toBeVisible();
    expect(state.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("新版本：0.4.11")).toBeVisible();
    expect(screen.getByText(/修复启动/)).toBeVisible();
    expect(screen.getByText("发布日期：2026-10-08")).toBeVisible();
    expect(state.install).not.toHaveBeenCalled();
  });

  it("keeps a skipped update visible and allows cancelling the skip or installing it", async () => {
    localStorage.setItem(SKIPPED_APP_UPDATE_KEY, "0.4.11");
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("新版本：0.4.11（已跳过）")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消跳过" }));
    expect(screen.getByText("新版本：0.4.11")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "跳过这个版本" }));
    expect(localStorage.getItem(SKIPPED_APP_UPDATE_KEY)).toBe("0.4.11");
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(state.install).toHaveBeenCalledWith("0.4.11"));
    expect(
      await screen.findByText("正在安装，完成后将自动重启…"),
    ).toBeVisible();
  });

  it("shows download progress, locks repeated actions, and exposes install failure with a download fallback", async () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await screen.findByRole("button", { name: "立即更新" });
    let reject!: (error: Error) => void;
    state.install.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "立即更新" }));
    await waitFor(() => expect(state.install).toHaveBeenCalledOnce());
    act(() =>
      state.emit({
        downloaded: 1024 * 1024,
        total: 2 * 1024 * 1024,
        phase: "downloading",
      }),
    );
    expect(
      screen.getByRole("progressbar", { name: "更新下载进度" }),
    ).toHaveAttribute("value", "1048576");
    expect(screen.getByText("正在下载：1.0 MB / 2.0 MB")).toBeVisible();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更新中…" })).toBeDisabled();
    await act(async () => {
      reject(new Error("更新安装失败，请重试"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("更新安装失败");
    expect(state.unlisten).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "打开下载页" }));
    await waitFor(() =>
      expect(state.openExternal).toHaveBeenCalledWith(
        "https://github.com/fy-agent/fyagent/releases",
      ),
    );
  });

  it("shows a readable manual check error and opens the download page through the shared external path", async () => {
    const state = setup();
    state.check.mockRejectedValue(new Error("无法检查更新，请检查网络"));
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请检查网络");
    expect(screen.queryByText("已是最新版本。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开下载页" }));
    await waitFor(() => expect(state.openExternal).toHaveBeenCalledOnce());
  });

  it("reports the latest version and renders release notes as plain text", async () => {
    const state = setup({ currentVersion: "0.4.10", update: null });
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("已是最新版本。")).toBeVisible();
    state.unmount();
    setup({
      ...update,
      update: {
        version: "0.4.11",
        notes: "<script>untrusted()</script>",
        date: null,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(
      await screen.findByText("<script>untrusted()</script>"),
    ).toBeVisible();
    expect(document.querySelector(".fy-app-update-notes script")).toBeNull();
  });
});
