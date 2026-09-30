// Build a per-runner summary (JSON + Markdown) from the smoke artifacts.
// Exits non-zero when install or launch failed so the matrix leg shows red.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.SMOKE_OUT ?? "smoke-out";
const id = process.env.SMOKE_ID ?? "unknown";
const load = (name) => {
  const p = join(out, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    return { parseError: String(error) };
  }
};

const sha = load("sha-check.json");
const buildSource = load("build-source.json");
const explorerPrep = load("explorer-prep.json");
const install = load("install.json");
const npmLatest = load("npm-latest.json");
const tools = load("tools-install.json");
const opencode = load("opencode-desktop.json");
const scenario = process.env.SMOKE_SCENARIO ?? "npm-preinstall";
const labels = scenario === "fyagent-e2e" ? ["after-e2e"] : ["baseline", "after-tools"];
const e2e = load("e2e.json");
const cliAfter = load(scenario === "fyagent-e2e" ? "cli-versions-after-e2e.json" : "cli-versions-after-tools.json");
const opencodeE2e = load("opencode-desktop-e2e.json");
const launches = Object.fromEntries(labels.map((l) => [l, load(`launch-${l}.json`)]));
const probes = Object.fromEntries(labels.map((l) => [l, load(`probe-${l}.json`)]));

const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined) return o[k];
  return undefined;
};

function detection(label) {
  const probe = probes[label];
  if (!probe) return null;
  const calls = probe.probe?.calls ?? [];
  const tv = calls.find((c) => c.cmd === "get_tool_versions");
  const toolVersions = Array.isArray(tv?.value)
    ? tv.value.map((t) => ({
        tool: t.name,
        version: t.version ?? null,
        latest: pick(t, "latest_version", "latestVersion") ?? null,
        error: t.error ?? null,
        installedButBroken: pick(t, "installed_but_broken", "installedButBroken") ?? null,
        latestAuthority: pick(t, "latest_authority", "latestAuthority") ?? null,
      }))
    : null;
  const inventories = calls
    .filter((c) => c.cmd === "get_agent_installation_inventory")
    .map((c) => ({ args: c.args, ok: c.ok, error: c.error ?? null, value: c.value ?? null }));
  return {
    cdpOk: probe.ok,
    error: probe.error ?? null,
    toolVersionsCall: tv ? { ok: tv.ok, error: tv.error ?? null } : null,
    toolVersions,
    inventories,
    failedCalls: calls.filter((c) => !c.ok).map((c) => ({ cmd: c.cmd, args: c.args, error: c.error })),
  };
}

const det = Object.fromEntries(labels.map((l) => [l, detection(l)]));
const latestByPkg = Object.fromEntries((npmLatest?.results ?? []).map((r) => [r.pkg, r.latest]));
const semverIn = (s) => (s ?? "").match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/)?.[0] ?? null;

const comparison = (tools?.results ?? []).map((r) => {
  const installed = semverIn(r.versionOutput);
  const appRow = det[labels[labels.length - 1]]?.toolVersions?.find((t) => t.tool === r.tool) ?? null;
  const npm = latestByPkg[r.pkg] ?? null;
  return {
    tool: r.tool,
    pkg: r.pkg,
    npmLatest: npm,
    installedCli: installed,
    npmInstallExit: r.npmExit,
    fyagentDetected: appRow ? appRow.version : null,
    fyagentLatest: appRow ? appRow.latest : null,
    fyagentError: appRow ? appRow.error : null,
    installedMatchesNpm: installed && npm ? installed === npm : null,
  };
});

const launchOk = (l) => Boolean(l && l.aliveAfter20s && l.aliveAfterProbe !== false);
const summary = {
  id,
  kind: "虚拟机实测 (GitHub-hosted VM)",
  generatedAt: new Date().toISOString(),
  tag: sha?.tag,
  sha,
  buildSource,
  explorerPrep,
  install: install
    ? {
        ok: install.ok,
        location: install.installLocation,
        exe: install.exe,
        exitCode: install.installerExitCode ?? null,
        seconds: install.installSeconds,
        windowsSignature: install.exeSignature?.status ?? null,
        installerSignature: install.installerSignature?.status ?? null,
        isAdmin: install.isAdmin ?? null,
        uacEnableLUA: install.uacEnableLUA ?? null,
        macCodesignVerifyExit: install.codesignVerifyExit ?? null,
        macSpctl: install.spctl ?? null,
        macStapler: install.stapler ?? null,
      }
    : null,
  launch: Object.fromEntries(labels.map((l) => [l, launches[l] ? { ok: launchOk(launches[l]), ...launches[l] } : null])),
  detection: det,
  npmLatest,
  comparison,
  opencodeDesktop: opencode,
  scenario,
  e2e: e2e ? { ok: e2e.ok ?? false, error: e2e.error ?? null, products: e2e.products ?? [] } : null,
  opencodeDesktopAfterE2e: opencodeE2e,
  toolsPresent: cliAfter,
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));

const yn = (v) => (v === true ? "是" : v === false ? "否" : "—");
const md = [];
md.push(`# ${id} 安装冒烟（虚拟机实测，GitHub-hosted VM）— 场景 ${scenario}`, "");
if (buildSource) {
  md.push(`> **非 release 构建**：fork 构建 run ${buildSource.runId}（${buildSource.repo}），源分支 \`${buildSource.ref}\` @ \`${buildSource.sourceSha}\`，未签名；下面的安装包 SHA-256 取自 fork 构建产物本身，与正式 Release 无关。`, "");
  md.push(`- 安装包：\`${buildSource.asset}\` sha256=\`${buildSource.sha256}\``, "");
}
if (explorerPrep) md.push(`- Explorer 预处理：before=${explorerPrep.before ?? "—"}；restarted=${explorerPrep.restarted}；after=${explorerPrep.after ?? "—"}`, "");
md.push(`- Tag：${sha?.tag ?? "?"}；manifest sourceSha：${sha?.manifestSourceSha ?? "?"}；生成时间（UTC）：${summary.generatedAt}`, "");
md.push("## SHA-256（本 runner 实算 vs 官方 manifest）", "", "| 文件 | 本机实算 | manifest | 一致 | provenance 一致 |", "| --- | --- | --- | --- | --- |");
for (const c of sha?.checks ?? []) md.push(`| ${c.name} | \`${c.actualSha256}\` | \`${c.manifestSha256}\` | ${yn(c.shaMatch && c.sizeMatch)} | ${yn(c.provenanceMatch)} |`);
md.push("", "## 安装", "");
if (install) {
  md.push(`- 结果：${install.ok ? "成功" : "失败"}；位置：\`${install.installLocation}\`；主程序：\`${install.exe}\``);
  if (install.installerSignature) md.push(`- Authenticode：安装包 ${install.installerSignature.status}，主程序 ${install.exeSignature?.status ?? "—"}（admin=${install.isAdmin}，EnableLUA=${install.uacEnableLUA}）`);
  if (install.codesignVerifyExit !== undefined) md.push(`- codesign verify exit=${install.codesignVerifyExit}；spctl：${(install.spctl ?? "").replace(/\n/g, " / ")}；stapler exit=${install.staplerExit}`);
}
md.push("", "## 启动", "", "| 阶段 | 20s 后进程存活 | 探测后存活 | 截图 |", "| --- | --- | --- | --- |");
for (const l of labels) {
  const x = launches[l];
  md.push(`| ${l} | ${yn(x?.aliveAfter20s)} | ${yn(x?.aliveAfterProbe)} | ${x?.desktopScreenshot ?? "—"}${probes[l]?.webviewScreenshot ? ", " + probes[l].webviewScreenshot : ""} |`);
}
md.push("", "## FyAgent 检测结果", "");
for (const l of labels) {
  const d = det[l];
  if (!d) {
    md.push(`- ${l}：无 CDP 探测（macOS 仅截图/日志）`);
    continue;
  }
  md.push(`- ${l}：CDP=${d.cdpOk ? "成功" : "失败"} ${d.error ? "(" + d.error.split("\n")[0] + ")" : ""}`);
  for (const t of d.toolVersions ?? []) md.push(`  - ${t.tool}: version=${t.version ?? "—"} latest=${t.latest ?? "—"} ${t.error ? "error=" + t.error : ""}`);
}
md.push("", "## 版本对照（npm latest 于 " + (npmLatest?.readAt ?? "?") + " 实时读取）", "", "| 工具 | npm 包 | npm latest | CLI 实装 --version | FyAgent 检测 | FyAgent 错误 |", "| --- | --- | --- | --- | --- | --- |");
for (const c of comparison) md.push(`| ${c.tool} | ${c.pkg} | ${c.npmLatest ?? "—"} | ${c.installedCli ?? "—"} | ${c.fyagentDetected ?? "—"} | ${c.fyagentError ?? ""} |`);
if (opencode) {
  md.push("", "## OpenCode Desktop", "");
  md.push(`- 下载：${opencode.finalUrl ?? opencode.sourceUrl}`);
  if (opencode.foundExecutables) {
    const seen = new Set();
    for (const f of opencode.foundExecutables.filter((x) => !seen.has(x.path) && seen.add(x.path))) md.push(`- 找到：\`${f.path}\`（${f.versionInfo?.productName ?? ""} ${f.versionInfo?.productVersion ?? ""}，签名 ${f.signature?.status ?? ""}）`);
    md.push(`- 命中代码候选路径：${yn(opencode.matchesCodeCandidate)}`);
  }
  if (opencode.infoPlist) md.push(`- Bundle：${opencode.infoPlist.CFBundleIdentifier} ${opencode.infoPlist.CFBundleShortVersionString}；与代码一致：${yn(opencode.bundleIdMatchesCode)}`);
}
if (e2e) {
  md.push("", "## 端到端：通过 FyAgent 自身按钮安装", "", `- 驱动结果：${e2e.ok ? "完成" : "中断"} ${e2e.error ? "(" + String(e2e.error).split("\n")[0] + ")" : ""}`);
  md.push("", "| 产品 | 一键安装 | 确认安装 | 结束时卡片文字 |", "| --- | --- | --- | --- |");
  for (const p of e2e.products ?? []) md.push(`| ${p.name} | ${String(p.oneClick ?? "—").replace(/\|/g, "/")} | ${p.confirm ?? "—"} | ${String(p.after ?? p.result ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160)} |`);
  md.push("", `- 引导：用途「${e2e.purpose ?? "—"}」点击结果 ${e2e.purposeClick ?? "—"}；完成方式 ${e2e.guideCompletedVia ?? "—"}`);
  if (e2e.directoryCards) md.push("- 目录页各卡片提供的按钮：" + e2e.directoryCards.map((c) => `${c.name}[${c.buttons.join("/")}]`).join("；"));
  const job = (e2e.products ?? []).find((p) => p.codexJob)?.codexJob ?? e2e.codexJobFinal;
  if (job) md.push("- Codex Desktop 任务快照（codex_desktop_get_job）：`" + JSON.stringify(job).slice(0, 600) + "`");
}
if (existsSync(join(out, "e2e-walk.log"))) md.push("", "## 端到端（macOS AX 驱动日志）", "", "```", readFileSync(join(out, "e2e-walk.log"), "utf8").slice(0, 6000), "```");
if (opencodeE2e) {
  const seen = new Set();
  md.push("", "## FyAgent 安装后的 OpenCode Desktop 位置", "");
  for (const f of (opencodeE2e.foundExecutables ?? []).filter((x) => !seen.has(x.path) && seen.add(x.path))) md.push(`- \`${f.path}\`（${f.versionInfo?.productVersion ?? ""}，PE ${f.peMachine ?? "?"}）`);
  md.push(`- 命中代码候选路径：${yn(opencodeE2e.matchesCodeCandidate)}`);
}
if (cliAfter) {
  md.push("", "## 场景结束时实际存在的工具（不经 FyAgent，直接 --version）", "", "| 命令 | PATH 命中 | --version | 其他位置 |", "| --- | --- | --- | --- |");
  for (const t of cliAfter.tools ?? []) md.push(`| ${t.bin} | ${t.where ?? "—"} | ${t.version ?? "—"} | ${(t.extra ?? []).map((x) => x.path + " " + (x.version ?? "")).join("; ")} |`);
  for (const a of cliAfter.apps ?? []) md.push(`- App：${a.path} ${a.bundleId ?? ""} ${a.version ?? ""}`);
}
md.push("", "## 限制", "", "- 这是 GitHub-hosted 虚拟机实测，不等于真机通过。", "- runner 以管理员身份运行，UAC 提示和 SmartScreen 界面不可观察；#68 验收中的 SmartScreen 警告和 UAC 提示不在覆盖范围内。", "- 未覆盖中国大陆网络环境和 npm 镜像路径（npmmirror 等）；runner 位于境外，直连 npmjs。npmmirror 目前仍把 Grok latest 标成 0.1.4（官方 1.0.44），FyAgent 没有让用户选择镜像的设置，本次未强制镜像场景。", "- Windows ARM64：npm-preinstall 场景由测试脚本直接装 OpenCode 官方 win-x64 安装包（仿真运行），不代表 ARM 用户（官方另有 win-arm64 构建）。FyAgent v0.4.9 自身在 Windows ARM64 上对 OpenCode Desktop 返回 PlatformUnsupported（agent_install/sources/opencode.rs），不提供一键安装，既不下载 win-arm64 也不下载 win-x64；Windows x64 上下载 stable/windows-x64-nsis。");
writeFileSync(join(out, "summary.md"), md.join("\n") + "\n");
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n", { flag: "a" });
console.log(md.join("\n"));

const failed = !sha?.ok || !install?.ok || (scenario === "npm-preinstall" ? !launchOk(launches.baseline) : false);
process.exit(failed ? 1 : 0);
