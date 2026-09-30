// Windows only: attach to the installed FyAgent WebView2 through the Chrome
// DevTools Protocol (enabled for this throwaway VM process only via
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>) and call
// the app's own read-only detection commands the renderer already uses.
// No install/update command is invoked.
//
// Usage: node cdp-probe.mjs <label>   Env: SMOKE_OUT, SMOKE_CDP_PORT (default 9222)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const label = process.argv[2] ?? "probe";
const out = process.env.SMOKE_OUT ?? "smoke-out";
const port = Number(process.env.SMOKE_CDP_PORT ?? 9222);
const timeoutMs = Number(process.env.SMOKE_CDP_TIMEOUT_MS ?? 90000);
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { label, startedAt: new Date().toISOString(), port, ok: false };

async function findTarget() {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      last = targets;
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return { page, targets };
    } catch (error) {
      last = String(error);
    }
    await sleep(2000);
  }
  throw new Error(`no CDP page target within ${timeoutMs} ms: ${JSON.stringify(last)}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = (e) => reject(new Error(`websocket error ${e?.message ?? ""}`));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          id += 1;
          const msgId = id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res) => pending.set(msgId, res));
        },
        close: () => ws.close(),
      });
  });
}

async function evaluate(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  if (res.error) throw new Error(JSON.stringify(res.error));
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 2000));
  }
  return res.result?.result?.value;
}

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
  const { page, targets } = await findTarget();
  report.targets = targets.map((t) => ({ type: t.type, url: t.url, title: t.title }));
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  // Let the renderer finish its own first scan before probing.
  await sleep(Number(process.env.SMOKE_SETTLE_MS ?? 15000));
  report.probe = await evaluate(cdp, PROBE);
  // Visible agents page: text + webview screenshot.
  await evaluate(cdp, `location.hash = "#/agents"; true`);
  await sleep(8000);
  report.agentsPageText = await evaluate(cdp, `document.body.innerText.slice(0, 20000)`);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) {
    writeFileSync(join(out, `webview-${label}.png`), Buffer.from(shot.result.data, "base64"));
    report.webviewScreenshot = `webview-${label}.png`;
  }
  report.ok = report.probe?.tauri === true;
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  cdp?.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, `probe-${label}.json`), JSON.stringify(report, null, 2));
  console.log(`probe ${label}: ok=${report.ok} ${report.error ?? ""}`);
}
