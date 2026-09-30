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
const install = load("install.json");
const npmLatest = load("npm-latest.json");
const tools = load("tools-install.json");
const opencode = load("opencode-desktop.json");
const labels = ["baseline", "after-tools"];
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
  const appRow = det["after-tools"]?.toolVersions?.find((t) => t.tool === r.tool) ?? null;
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
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));

const yn = (v) => (v === true ? "是" : v === false ? "否" : "—");
const md = [];
md.push(`# ${id} 安装冒烟（虚拟机实测，GitHub-hosted VM）`, "");
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
    for (const f of opencode.foundExecutables) md.push(`- 找到：\`${f.path}\`（${f.versionInfo?.productName ?? ""} ${f.versionInfo?.productVersion ?? ""}，签名 ${f.signature?.status ?? ""}）`);
    md.push(`- 命中代码候选路径：${yn(opencode.matchesCodeCandidate)}`);
  }
  if (opencode.infoPlist) md.push(`- Bundle：${opencode.infoPlist.CFBundleIdentifier} ${opencode.infoPlist.CFBundleShortVersionString}；与代码一致：${yn(opencode.bundleIdMatchesCode)}`);
}
md.push("", "## 限制", "", "- 这是 GitHub-hosted 虚拟机实测，不等于真机通过。", "- runner 以管理员身份运行，UAC 提示和 SmartScreen 界面不可观察；#68 验收中的 SmartScreen 警告和 UAC 提示不在覆盖范围内。");
writeFileSync(join(out, "summary.md"), md.join("\n") + "\n");
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n", { flag: "a" });
console.log(md.join("\n"));

const failed = !sha?.ok || !install?.ok || !launchOk(launches.baseline);
process.exit(failed ? 1 : 0);
