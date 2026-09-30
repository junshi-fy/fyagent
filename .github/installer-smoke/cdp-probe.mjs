// Windows only: attach to the installed FyAgent WebView2 through the Chrome
// DevTools Protocol (enabled for this throwaway VM process only via
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>) and call
// the app's own read-only detection commands the renderer already uses.
// No install/update command is invoked.
//
// Usage: node cdp-probe.mjs <label>   Env: SMOKE_OUT, SMOKE_CDP_PORT (default 9222)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, evaluate, findTarget, sleep } from "./cdp-lib.mjs";

const label = process.argv[2] ?? "probe";
const out = process.env.SMOKE_OUT ?? "smoke-out";
const port = Number(process.env.SMOKE_CDP_PORT ?? 9222);
const timeoutMs = Number(process.env.SMOKE_CDP_TIMEOUT_MS ?? 90000);
mkdirSync(out, { recursive: true });
const report = { label, startedAt: new Date().toISOString(), port, ok: false };

const AGENT_IDS = ["qoderwork", "trae-work", "workbuddy", "grokbuild", "codex", "claude-code", "opencode"];
const TOOLS = ["claude", "codex", "gemini", "grok", "opencode", "openclaw", "hermes"];

const PROBE = `(async () => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    return { tauri: false };
  }
  const calls = [];
  const call = async (cmd, args) => {
    const started = performance.now();
    try {
      const value = await internals.invoke(cmd, args ?? {});
      calls.push({ cmd, args: args ?? {}, ok: true, ms: Math.round(performance.now() - started), value });
    } catch (error) {
      calls.push({ cmd, args: args ?? {}, ok: false, ms: Math.round(performance.now() - started),
        error: typeof error === "string" ? error : JSON.stringify(error) });
    }
  };
  await call("get_agent_catalog");
  await call("get_tool_versions", {});
  await call("probe_tool_installations", { tools: ${JSON.stringify(TOOLS)} });
  for (const agentId of ${JSON.stringify(AGENT_IDS)}) {
    await call("get_external_agent_status", { agentId });
    await call("get_agent_install_readiness", { agentId });
    await call("get_agent_installation_inventory", { agentId });
  }
  await call("get_agent_installation_inventory", { agentId: "opencode", surface: "desktop" });
  await call("get_agent_installation_inventory", { agentId: "opencode", surface: "cli" });
  await call("get_runtime_privilege_status");
  return { tauri: true, href: location.href, calls };
})()`;

let cdp;
try {
  const { page, targets } = await findTarget(port, timeoutMs);
  report.targets = targets.map((t) => ({ type: t.type, url: t.url, title: t.title }));
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  // Let the renderer finish its own first scan before probing.
  await sleep(Number(process.env.SMOKE_SETTLE_MS ?? 15000));
  report.probe = await evaluate(cdp, PROBE);
  // UI walk: same pages a user would open, captured as text + webview PNG.
  const clickText = (text) => `(() => {
    const want = ${JSON.stringify(text)};
    const nodes = [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=link], li, h2, h3, span, div")]
      .filter((n) => n.offsetParent !== null && (n.innerText || "").trim() === want);
    const node = nodes.find((n) => n.matches("button, a, [role=button], [role=tab], [role=link]")) ?? nodes[nodes.length - 1];
    if (!node) return "NOT FOUND";
    (node.closest("button, a, [role=button], [role=link]") ?? node).click();
    return "clicked " + node.tagName;
  })()`;
  report.ui = [];
  const capture = async (step, action) => {
    const entry = { step };
    try {
      if (action) entry.action = await evaluate(cdp, action);
      await sleep(Number(process.env.SMOKE_UI_SETTLE_MS ?? 8000));
      entry.hash = await evaluate(cdp, "location.hash");
      entry.text = await evaluate(cdp, "document.body.innerText.slice(0, 20000)");
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      if (shot.result?.data) {
        entry.screenshot = `webview-${label}-${step}.png`;
        writeFileSync(join(out, entry.screenshot), Buffer.from(shot.result.data, "base64"));
      }
    } catch (error) {
      entry.error = String(error);
    }
    report.ui.push(entry);
  };
  await capture("start");
  await capture("skip-guide", clickText("跳过引导"));
  for (const [slug, name] of [["opencode", "OpenCode"], ["codex", "Codex"], ["claude-code", "Claude Code"], ["grokbuild", "Grok Build"]]) {
    await evaluate(cdp, `location.hash = "#/agents"; true`);
    await sleep(3000);
    await capture(`agent-${slug}`, clickText(name));
  }
  await capture("health", `location.hash = "#/health"; "hash set"`);
  report.agentsPageText = report.ui.find((u) => u.step === "skip-guide")?.text ?? null;
  report.ok = report.probe?.tauri === true;
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  cdp?.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, `probe-${label}.json`), JSON.stringify(report, null, 2));
  console.log(`probe ${label}: ok=${report.ok} ${report.error ?? ""}`);
}
