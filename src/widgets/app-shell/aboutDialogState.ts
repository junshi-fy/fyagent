import { detectNativePlatform } from "../../shared/platform";

export const PROJECT_URL = "https://github.com/fy-agent/fyagent";

export const STAR_PROMPT_DISMISSED_KEY = "fyagent:about:starPromptDismissed";

export function readStarPromptDismissed(): boolean {
  try {
    return localStorage.getItem(STAR_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissStarPrompt(): void {
  try {
    localStorage.setItem(STAR_PROMPT_DISMISSED_KEY, "1");
  } catch {
    // Storage denied or unavailable
  }
}

export function resetStarPromptDismissed(): void {
  try {
    localStorage.removeItem(STAR_PROMPT_DISMISSED_KEY);
  } catch {
    // Storage denied or unavailable
  }
}

export function buildFeedbackUrl({
  version,
  platform = detectNativePlatform(globalThis.navigator),
}: {
  version?: string | null;
  platform?: string;
}): string {
  const params = new URLSearchParams();
  params.set("template", "bug_report.yml");
  if (version) {
    params.set("version", version);
  }
  if (platform === "windows" || platform === "macos") {
    params.set("os", platform === "windows" ? "Windows" : "macOS");
  }
  return `${PROJECT_URL}/issues/new?${params.toString()}`;
}

export const ABOUT_COPY = {
  title: "关于 FyAgent",
  description: "在一个地方安装 AI 软件、连接模型，并管理项目所需的配置。",
  close: "关闭",
  currentVersion: "当前版本",
  versionUnavailable: "版本信息暂不可用",
  loading: "正在读取…",
  reload: "重新读取",
  checkUpdates: "查看更新",
  helpAndFeedback: "帮助与反馈",
  feedback: "反馈问题",
  starPrompt: "如果 FyAgent 帮到了你，请在 GitHub 点个 Star，这对我们意义重大",
  starButton: "去点 Star",
  dismissStarPrompt: "关闭点星提示",
  releaseAndLicense: "发布与许可",
  releaseDescription: "更新页面提供各版本的变更说明、安装包和发布信息。",
  projectHome: "项目主页",
  softwareLicense: "软件许可",
  thirdPartyNotices: "第三方声明",
};
