import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureProvider } from "@/shared/features/provider";
import { createBrowserFeaturePorts } from "@/shared/platform/browser/features";
import { TopBar } from "@/widgets/app-shell/TopBar";
import AboutDialog from "@/widgets/app-shell/AboutDialog";
import {
  PROJECT_URL,
  STAR_PROMPT_DISMISSED_KEY,
  readStarPromptDismissed,
  resetStarPromptDismissed,
} from "@/widgets/app-shell/aboutDialogState";

function fixture(readVersion = vi.fn(async () => "9.8.7")) {
  const ports = createBrowserFeaturePorts();
  ports.settings.getAppVersion = readVersion;
  const openExternal = vi.fn(async () => {});
  ports.settings.openExternal = openExternal;
  render(
    <FeatureProvider ports={ports}>
      <TopBar />
    </FeatureProvider>,
  );
  return { readVersion, openExternal, user: userEvent.setup() };
}

function directFixture(user = userEvent.setup()) {
  const ports = createBrowserFeaturePorts();
  ports.settings.getAppVersion = vi.fn(async () => "9.8.7");
  const openExternal = vi.fn(async () => {});
  ports.settings.openExternal = openExternal;
  const result = render(
    <FeatureProvider ports={ports}>
      <AboutDialog
        open={true}
        onOpenChange={() => {}}
        originRef={{ current: null }}
      />
    </FeatureProvider>,
  );
  return { ...result, openExternal, user };
}

describe("About dialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.clear();
    resetStarPromptDismissed();
  });

  it("loads the actual version on opening, opens only the selected link, and restores keyboard focus", async () => {
    const { readVersion, openExternal, user } = fixture();
    expect(readVersion).not.toHaveBeenCalled();
    const trigger = screen.getByRole("button", { name: "关于 FyAgent" });
    await user.click(trigger);
    // Await the real lazy chunk before asserting the dialog. A cold import
    // can outlast the DOM polling window when the full suite compiles in parallel.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const dialog = await screen.findByRole("dialog", { name: "关于 FyAgent" });
    expect(await within(dialog).findByText("9.8.7")).toBeVisible();
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
    const details = within(dialog).getByText("发布与许可").closest("details");
    expect(details).not.toHaveAttribute("open");
    await user.click(within(dialog).getByRole("button", { name: "查看更新" }));
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://github.com/fy-agent/fyagent/releases",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "帮助与反馈" }),
    );
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://github.com/fy-agent/fyagent/issues",
    );
    await user.click(within(dialog).getByText("发布与许可"));
    expect(details).toHaveAttribute("open");
    await user.click(within(dialog).getByRole("button", { name: "软件许可" }));
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://github.com/fy-agent/fyagent/blob/main/LICENSING.md",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("shows a bounded unavailable state and retries without exposing diagnostics", async () => {
    const readVersion = vi
      .fn()
      .mockRejectedValueOnce(new Error("private diagnostic"))
      .mockResolvedValue("8.7.6");
    const { user, openExternal } = fixture(readVersion);
    await user.click(screen.getByRole("button", { name: "关于 FyAgent" }));
    expect(await screen.findByText("版本信息暂不可用")).toBeVisible();
    expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("8.7.6")).toBeVisible();
    expect(readVersion).toHaveBeenCalledTimes(2);
    expect(openExternal).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it.each([
    [
      "Windows",
      { platform: "Win32", userAgent: "Windows NT 10.0" },
      "https://github.com/fy-agent/fyagent/issues/new?template=bug_report.yml&version=9.8.7&os=Windows",
    ],
    [
      "macOS",
      { platform: "MacIntel", userAgent: "Macintosh" },
      "https://github.com/fy-agent/fyagent/issues/new?template=bug_report.yml&version=9.8.7&os=macOS",
    ],
    [
      "unknown",
      undefined,
      "https://github.com/fy-agent/fyagent/issues/new?template=bug_report.yml&version=9.8.7",
    ],
  ])(
    "opens feedback with version and the supported OS for %s",
    async (_name, navigatorIdentity, expectedUrl) => {
      const user = userEvent.setup();
      vi.stubGlobal("navigator", navigatorIdentity);
      const { openExternal } = directFixture(user);
      expect(await screen.findByText("9.8.7")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "反馈问题" }));
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(expectedUrl);
    },
  );

  it("displays dismissible star banner and permanently never appears again after dismissal", async () => {
    const { openExternal, user } = fixture();
    const trigger = screen.getByRole("button", { name: "关于 FyAgent" });
    await user.click(trigger);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const dialog = await screen.findByRole("dialog", { name: "关于 FyAgent" });

    // Star prompt is displayed initially
    expect(
      within(dialog).getByText(
        "如果 FyAgent 帮到了你，请在 GitHub 点个 Star，这对我们意义重大",
      ),
    ).toBeVisible();
    const starButton = within(dialog).getByRole("button", {
      name: "去点 Star",
    });
    expect(starButton).toBeVisible();

    // Clicking star button opens repository
    await user.click(starButton);
    expect(openExternal).toHaveBeenLastCalledWith(PROJECT_URL);

    // Dismiss star banner
    const dismissButton = within(dialog).getByRole("button", {
      name: "关闭点星提示",
    });
    await user.click(dismissButton);

    // Banner is dismissed immediately
    expect(
      within(dialog).queryByText(
        "如果 FyAgent 帮到了你，请在 GitHub 点个 Star，这对我们意义重大",
      ),
    ).not.toBeInTheDocument();
    expect(readStarPromptDismissed()).toBe(true);
    expect(localStorage.getItem(STAR_PROMPT_DISMISSED_KEY)).toBe("1");

    // Close and reopen the dialog: star banner never appears again
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await user.click(trigger);
    const reopenedDialog = await screen.findByRole("dialog", {
      name: "关于 FyAgent",
    });
    expect(
      within(reopenedDialog).queryByText(
        "如果 FyAgent 帮到了你，请在 GitHub 点个 Star，这对我们意义重大",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(reopenedDialog).queryByRole("button", { name: "去点 Star" }),
    ).not.toBeInTheDocument();
  });

  it("hides the banner on first mount when dismissal is already stored", () => {
    localStorage.setItem(STAR_PROMPT_DISMISSED_KEY, "1");
    directFixture();
    expect(
      screen.queryByRole("button", { name: "关闭点星提示" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "关于 FyAgent" })).toBeVisible();
  });

  it("keeps the banner dismissed after unmounting and mounting again", async () => {
    const { user, unmount } = directFixture();
    await user.click(screen.getByRole("button", { name: "关闭点星提示" }));
    unmount();
    directFixture();
    expect(
      screen.queryByRole("button", { name: "关闭点星提示" }),
    ).not.toBeInTheDocument();
  });

  it("shows and dismisses the banner when reading storage throws", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("Storage denied");
      });
    const { user } = directFixture();
    expect(getItem).toHaveBeenCalledWith(STAR_PROMPT_DISMISSED_KEY);
    await user.click(screen.getByRole("button", { name: "关闭点星提示" }));
    expect(
      screen.queryByRole("button", { name: "关闭点星提示" }),
    ).not.toBeInTheDocument();
  });

  it("dismisses in memory when writing storage throws and shows again on remount", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage denied");
      });
    const { user, unmount } = directFixture();
    await user.click(screen.getByRole("button", { name: "关闭点星提示" }));
    expect(setItem).toHaveBeenCalledWith(STAR_PROMPT_DISMISSED_KEY, "1");
    expect(
      screen.queryByRole("button", { name: "关闭点星提示" }),
    ).not.toBeInTheDocument();
    unmount();
    directFixture();
    expect(screen.getByRole("button", { name: "关闭点星提示" })).toBeVisible();
  });

  it.each(["{Enter}", " "])(
    "dismisses the banner using the keyboard: %s",
    async (key) => {
      vi.stubGlobal("PointerEvent", MouseEvent);
      const { user } = directFixture();
      screen.getByRole("button", { name: "关闭点星提示" }).focus();
      await user.keyboard(key);
      expect(
        screen.queryByRole("button", { name: "关闭点星提示" }),
      ).not.toBeInTheDocument();
      expect(localStorage.getItem(STAR_PROMPT_DISMISSED_KEY)).toBe("1");
    },
  );
});
