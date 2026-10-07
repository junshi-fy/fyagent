import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const overlayState = vi.hoisted(() => ({ show: false }));

vi.mock("@/shared/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/platform")>();
  return {
    ...actual,
    shouldShowMacOverlayDragStrip: () => overlayState.show,
  };
});

import { FeatureProvider } from "@/shared/features/provider";
import {
  AppUpdateProvider,
  useAppUpdate,
} from "@/shared/features/app-update/provider";
import { SKIPPED_APP_UPDATE_KEY } from "@/shared/features/app-update/useAppUpdateController";
import { createBrowserFeaturePorts } from "@/shared/platform/browser/features";
import { TooltipProvider } from "@/shared/ui/primitives";
import { TopBar } from "@/widgets/app-shell/TopBar";

function renderTopBar() {
  return render(
    <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      <TopBar />
    </TooltipProvider>,
  );
}

describe("TopBar macOS Overlay drag strip", () => {
  beforeEach(() => {
    overlayState.show = false;
  });

  it("keeps the browser shell free of a drag region", () => {
    overlayState.show = false;
    renderTopBar();

    expect(
      screen.queryByTestId("titlebar-drag-region"),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull();
    expect(screen.getByTestId("brand")).toBeVisible();
    expect(screen.queryByTestId("tool-cluster")).not.toBeInTheDocument();
    for (const name of ["搜索", "设置", "账户"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      Array.from(
        screen
          .getByTestId("top-bar")
          .querySelectorAll(
            '[data-testid="brand"], [data-testid="tool-cluster"]',
          ),
      ).map((element) => element.getAttribute("data-testid")),
    ).toEqual(["brand"]);
  });

  it("places an inert drag strip above the chrome row on native macOS", () => {
    overlayState.show = true;
    renderTopBar();

    const topBar = screen.getByTestId("top-bar");
    const dragStrip = screen.getByTestId("titlebar-drag-region");
    const chrome = topBar.querySelector(".fy-top-bar-chrome");
    const dragSurface = document.querySelector("[data-tauri-drag-region]");

    expect(dragStrip).toBeVisible();
    expect(dragSurface).not.toBeNull();
    expect(chrome).not.toBeNull();
    expect(dragStrip.compareDocumentPosition(chrome!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen.queryByRole("button", { name: "关闭" }),
    ).not.toBeInTheDocument();
  });
});

describe("TopBar application update indicator", () => {
  it("shows an accessible dot for an available version and removes it after skipping", async () => {
    localStorage.clear();
    const ports = createBrowserFeaturePorts();
    let version = "0.4.11";
    ports.settings.getAppVersion = async () => "0.4.10";
    ports.appUpdate.check = async () => ({
      currentVersion: "0.4.10",
      update: { version, notes: null, date: null },
    });
    let controller!: ReturnType<typeof useAppUpdate>;
    function Controls() {
      controller = useAppUpdate();
      return <TopBar />;
    }
    const view = render(
      <FeatureProvider ports={ports}>
        <AppUpdateProvider>
          <TooltipProvider>
            <Controls />
          </TooltipProvider>
        </AppUpdateProvider>
      </FeatureProvider>,
    );
    expect(screen.getByRole("button", { name: "关于 FyAgent" })).toBeVisible();
    expect(document.querySelector(".fy-app-update-dot")).toBeNull();
    await act(() => controller.check());
    expect(
      screen.getByRole("button", { name: "关于 FyAgent，有新版本" }),
    ).toBeVisible();
    expect(document.querySelector(".fy-app-update-dot")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    act(() => controller.skipVersion());
    expect(screen.getByRole("button", { name: "关于 FyAgent" })).toBeVisible();
    expect(document.querySelector(".fy-app-update-dot")).toBeNull();
    expect(localStorage.getItem(SKIPPED_APP_UPDATE_KEY)).toBe("0.4.11");
    version = "0.4.12";
    await act(() => controller.check());
    expect(
      screen.getByRole("button", { name: "关于 FyAgent，有新版本" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.unmount();
    localStorage.clear();
  });
});
