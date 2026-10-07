import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureProvider } from "@/shared/features/provider";
import { createBrowserFeaturePorts } from "@/shared/platform/browser/features";
import { detectNativePlatform } from "@/shared/platform";
import { TopBar } from "@/widgets/app-shell/TopBar";
import AboutDialog from "@/widgets/app-shell/AboutDialog";
import {
  ABOUT_COPY,
  PROJECT_URL,
  STAR_PROMPT_DISMISSED_KEY,
  buildFeedbackUrl,
  readStarPromptDismissed,
  resetStarPromptDismissed,
  resolveAboutLocale,
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

describe("About dialog", () => {
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

  it("opens feedback issue with current version and system platform", async () => {
    const { openExternal, user } = fixture();
    const trigger = screen.getByRole("button", { name: "关于 FyAgent" });
    await user.click(trigger);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const dialog = await screen.findByRole("dialog", { name: "关于 FyAgent" });
    expect(await within(dialog).findByText("9.8.7")).toBeVisible();

    const feedbackButton = within(dialog).getByRole("button", {
      name: "反馈问题",
    });
    await user.click(feedbackButton);

    const expectedUrl = buildFeedbackUrl({
      version: "9.8.7",
      platform: detectNativePlatform(),
    });
    expect(openExternal).toHaveBeenLastCalledWith(expectedUrl);
    expect(expectedUrl).toContain(
      "https://github.com/fy-agent/fyagent/issues/new",
    );
    expect(expectedUrl).toContain("template=bug_report.yml");
    expect(expectedUrl).toContain("version=9.8.7");
    expect(expectedUrl).toContain(`platform=${detectNativePlatform()}`);
  });

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
    const starButton = within(dialog).getByRole(
      "button",
      { name: "去点 Star" },
    );
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

  it("supports zh, en, and ja locales with complete copy dictionary", () => {
    expect(resolveAboutLocale("zh")).toBe("zh");
    expect(resolveAboutLocale("zh-CN")).toBe("zh");
    expect(resolveAboutLocale("en")).toBe("en");
    expect(resolveAboutLocale("en-US")).toBe("en");
    expect(resolveAboutLocale("ja")).toBe("ja");
    expect(resolveAboutLocale("ja-JP")).toBe("ja");
    expect(resolveAboutLocale(undefined)).toBe("zh");

    for (const lang of ["zh", "en", "ja"] as const) {
      const copy = ABOUT_COPY[lang];
      expect(copy.title).toBeTruthy();
      expect(copy.description).toBeTruthy();
      expect(copy.close).toBeTruthy();
      expect(copy.currentVersion).toBeTruthy();
      expect(copy.versionUnavailable).toBeTruthy();
      expect(copy.checkUpdates).toBeTruthy();
      expect(copy.helpAndFeedback).toBeTruthy();
      expect(copy.feedback).toBeTruthy();
      expect(copy.starPrompt).toBeTruthy();
      expect(copy.starButton).toBeTruthy();
      expect(copy.dismissStarPrompt).toBeTruthy();
      expect(copy.releaseAndLicense).toBeTruthy();
    }
  });

  it("renders with custom locale prop for en and ja", () => {
    const originRef = { current: null };
    const ports = createBrowserFeaturePorts();

    // Render English
    const { unmount: unmountEn } = render(
      <FeatureProvider ports={ports}>
        <AboutDialog
          open={true}
          onOpenChange={() => {}}
          originRef={originRef}
          locale="en"
        />
      </FeatureProvider>,
    );
    expect(
      screen.getByRole("dialog", { name: "About FyAgent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "If FyAgent has helped you, please star us on GitHub — it means a lot to us",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Star on GitHub" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Report Issue" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss star prompt" }),
    ).toBeInTheDocument();
    unmountEn();

    // Render Japanese
    const { unmount: unmountJa } = render(
      <FeatureProvider ports={ports}>
        <AboutDialog
          open={true}
          onOpenChange={() => {}}
          originRef={originRef}
          locale="ja"
        />
      </FeatureProvider>,
    );
    expect(
      screen.getByRole("dialog", { name: "FyAgent について" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "FyAgent がお役に立てたなら、GitHub でスターをお願いします。私たちにとって大きな励みになります",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "GitHub でスター" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "問題を報告" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "スターの案内を閉じる" }),
    ).toBeInTheDocument();
    unmountJa();
  });
});
