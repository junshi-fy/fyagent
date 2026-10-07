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
  platform = detectNativePlatform(),
}: {
  version?: string | null;
  platform?: string;
}): string {
  const params = new URLSearchParams();
  params.set("template", "bug_report.yml");
  if (version) {
    params.set("version", version);
  }
  if (platform) {
    params.set("platform", platform);
  }
  return `${PROJECT_URL}/issues/new?${params.toString()}`;
}

export type AboutLocale = "zh" | "en" | "ja";

export const ABOUT_COPY: Record<
  AboutLocale,
  {
    title: string;
    description: string;
    close: string;
    currentVersion: string;
    versionUnavailable: string;
    loading: string;
    reload: string;
    checkUpdates: string;
    helpAndFeedback: string;
    feedback: string;
    starPrompt: string;
    starButton: string;
    dismissStarPrompt: string;
    releaseAndLicense: string;
    releaseDescription: string;
    projectHome: string;
    softwareLicense: string;
    thirdPartyNotices: string;
  }
> = {
  zh: {
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
    starPrompt:
      "如果 FyAgent 帮到了你，请在 GitHub 点个 Star，这对我们意义重大",
    starButton: "去点 Star",
    dismissStarPrompt: "关闭点星提示",
    releaseAndLicense: "发布与许可",
    releaseDescription: "更新页面提供各版本的变更说明、安装包和发布信息。",
    projectHome: "项目主页",
    softwareLicense: "软件许可",
    thirdPartyNotices: "第三方声明",
  },
  en: {
    title: "About FyAgent",
    description:
      "Install AI software, connect models, and manage project configurations in one place.",
    close: "Close",
    currentVersion: "Current Version",
    versionUnavailable: "Version information temporarily unavailable",
    loading: "Loading…",
    reload: "Reload",
    checkUpdates: "Check for Updates",
    helpAndFeedback: "Help & Feedback",
    feedback: "Report Issue",
    starPrompt:
      "If FyAgent has helped you, please star us on GitHub — it means a lot to us",
    starButton: "Star on GitHub",
    dismissStarPrompt: "Dismiss star prompt",
    releaseAndLicense: "Releases & Licensing",
    releaseDescription:
      "Release notes, installer packages, and publishing details are available on the releases page.",
    projectHome: "Project Homepage",
    softwareLicense: "Software License",
    thirdPartyNotices: "Third-Party Notices",
  },
  ja: {
    title: "FyAgent について",
    description:
      "1つの場所で AI ソフトウェアをインストールし、モデルを接続し、プロジェクト構成を管理します。",
    close: "閉じる",
    currentVersion: "現在のバージョン",
    versionUnavailable: "バージョン情報は現在利用できません",
    loading: "読み込み中…",
    reload: "再読み込み",
    checkUpdates: "更新を確認",
    helpAndFeedback: "ヘルプとフィードバック",
    feedback: "問題を報告",
    starPrompt:
      "FyAgent がお役に立てたなら、GitHub でスターをお願いします。私たちにとって大きな励みになります",
    starButton: "GitHub でスター",
    dismissStarPrompt: "スターの案内を閉じる",
    releaseAndLicense: "リリースとライセンス",
    releaseDescription:
      "更新ページで各バージョンのリリースノート、インストーラー、公開情報を提供しています。",
    projectHome: "プロジェクトホームページ",
    softwareLicense: "ソフトウェアライセンス",
    thirdPartyNotices: "サードパーティに関する通知",
  },
};

export function resolveAboutLocale(locale?: string): AboutLocale {
  if (locale) {
    const candidate = locale.toLowerCase();
    if (candidate.startsWith("ja")) return "ja";
    if (candidate.startsWith("en")) return "en";
    return "zh";
  }
  return "zh";
}
