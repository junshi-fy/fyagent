// Windows only: drive the installed FyAgent like a first-time user through the
// WebView2 DevTools protocol. Onboarding -> "编程开发" -> all software -> for
// each product card press FyAgent's own "一键安装" and "确认安装", then wait and
// screenshot (webview + desktop) until the card settles.
// Usage: node cdp-e2e.mjs   Env: SMOKE_OUT, SMOKE_CDP_PORT, SMOKE_E2E_AGENTS, SMOKE_E2E_WAIT_S
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, evaluate, findTarget, sleep } from "./cdp-lib.mjs";

const out = process.env.SMOKE_OUT ?? "smoke-out";
const port = Number(process.env.SMOKE_CDP_PORT ?? 9222);
const agents = (process.env.SMOKE_E2E_AGENTS || "Claude Code,OpenCode,Grok Build,QoderWork CN,TRAE Work CN,WorkBuddy,Codex").split(",").map((a) => a.trim()).filter(Boolean);
const purpose = process.env.SMOKE_E2E_PURPOSE ?? "编程开发";
const waitS = Number(process.env.SMOKE_E2E_WAIT_S ?? 300);
mkdirSync(out, { recursive: true });
const report = { scenario: "fyagent-e2e", startedAt: new Date().toISOString(), steps: [], products: [] };
let n = 0;

function desktopShot(name) {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
      $bmp.Save('${join(out, name).replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`], { timeout: 30000 });
    return name;
  } catch (error) {
    return `failed: ${error}`;
  }
}

// Match a visible, enabled button by exact text, first line, or aria-label
// (the onboarding choices render "编程开发\n写代码、修问题与测试").
const CLICK_TEXT = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const vis = (n) => n.offsetParent !== null || n.getClientRects().length > 0;
  const label = (n) => { const t = (n.innerText || "").trim(); return [t, t.split("\\n")[0].trim(), (n.getAttribute("aria-label") || "").trim()]; };
  const nodes = [...document.querySelectorAll("button, a, [role=button]")].filter((n) => vis(n) && !n.disabled && label(n).includes(want));
  if (!nodes.length) return "NOT FOUND";
  nodes[nodes.length - 1].click();
  return "clicked";
})()`;

// The product card is the <article> that owns the exact <h2> heading
// (AgentDirectory.tsx). Only buttons inside that card are eligible.
const CARD = (name) => `[...document.querySelectorAll("article h2")].filter((h) => (h.innerText || "").trim() === ${JSON.stringify(name)}).map((h) => h.closest("article"))[0] || null`;

const CLICK_IN_CARD = (name, button) => `(() => {
  const card = ${CARD(name)};
  if (!card) return "NO CARD";
  const buttons = [...card.querySelectorAll("button")];
  const b = buttons.find((x) => (x.innerText || "").trim() === ${JSON.stringify(button)});
  if (!b) return "NO BUTTON (card buttons: " + buttons.map((x) => (x.innerText || "").trim()).join(" / ") + ")";
  if (b.disabled) return "DISABLED";
  b.scrollIntoView({ block: "center" });
  b.click();
  return "clicked";
})()`;

const CARD_TEXT = (name) => `(() => { const c = ${CARD(name)}; return c ? (c.innerText || "").slice(0, 1500) : null; })()`;
const CARD_BUSY = (name) => `(() => { const c = ${CARD(name)}; return !!(c && c.querySelector(".fy-agent-directory-lifecycle-status, [role=status]")); })()`;
const ANY_BUSY = `document.querySelectorAll(".fy-agent-directory-lifecycle-status").length`;
const CARD_SUMMARY = `[...document.querySelectorAll("article h2")].map((h) => { const c = h.closest("article"); return { name: (h.innerText || "").trim(), buttons: [...c.querySelectorAll("button")].map((x) => (x.innerText || "").trim()), text: (c.innerText || "").slice(0, 400) }; })`;
const INVOKE = (cmd, args) => `(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})}) }; } catch (e) { return { ok: false, error: typeof e === "string" ? e : JSON.stringify(e) }; } })()`;

async function rescan() {
  await evaluate(cdp, `location.hash = "#/agents"; true`);
  await sleep(3000);
  await evaluate(cdp, CLICK_TEXT("重新扫描"));
  await sleep(8000);
}

let cdp;
async function step(name, action, settleMs = 6000) {
  n += 1;
  const tag = `${String(n).padStart(2, "0")}-${name}`;
  const entry = { tag, at: new Date().toISOString() };
  try {
    if (action) entry.action = await evaluate(cdp, action);
    await sleep(settleMs);
    entry.hash = await evaluate(cdp, "location.hash");
    const dialog = await evaluate(cdp, `[...document.querySelectorAll("[role=dialog], [role=alertdialog]")].map((d) => d.innerText).join("\\n---\\n").slice(0, 4000)`);
    if (dialog) entry.dialog = dialog;
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (shot.result?.data) {
      entry.webview = `e2e-${tag}.png`;
      writeFileSync(join(out, entry.webview), Buffer.from(shot.result.data, "base64"));
    }
    entry.desktop = desktopShot(`e2e-${tag}-desktop.png`);
  } catch (error) {
    entry.error = String(error);
  }
  report.steps.push(entry);
  console.log(`${tag}: ${entry.action ?? ""} ${entry.error ?? ""}`);
  return entry;
}

try {
  const { page } = await findTarget(port, 90000);
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await sleep(15000);
  await step("first-run", null, 1000);
  report.firstRunText = await evaluate(cdp, "document.body.innerText.slice(0, 4000)");
  const pick = await step("pick-coding", CLICK_TEXT(purpose));
  report.purpose = purpose;
  report.purposeClick = pick.action;
  report.recommendationText = await evaluate(cdp, "document.body.innerText.slice(0, 6000)");
  const all = await step("view-all", CLICK_TEXT("查看全部软件"));
  report.guideCompletedVia = all.action === "clicked" ? "查看全部软件" : null;
  if (all.action !== "clicked") {
    const skip = await step("skip-guide", CLICK_TEXT("跳过引导"));
    report.guideCompletedVia = skip.action === "clicked" ? "跳过引导 (fallback)" : "none";
  }
  await step("directory", `location.hash = "#/agents"; "ok"`, 10000);
  report.directoryText = await evaluate(cdp, "document.body.innerText.slice(0, 20000)");
  // Optional repro: keep creating sibling directories under SMOKE_E2E_CHURN_DIR
  // while installs run (normal Windows activity in e.g. C:\ProgramData).
  const churnDir = process.env.SMOKE_E2E_CHURN_DIR;
  if (churnDir) {
    const script = `$d = '${churnDir.replace(/'/g, "''")}'; $end = (Get-Date).AddMinutes(20); $i = 0; while ((Get-Date) -lt $end) { $i++; New-Item -ItemType Directory -Force -Path (Join-Path $d ("smoke-churn-" + $i)) | Out-Null; Start-Sleep -Milliseconds 200 }`;
    spawn("powershell", ["-NoProfile", "-Command", script], { detached: true, stdio: "ignore" }).unref();
    report.churn = { dir: churnDir, startedAt: new Date().toISOString(), everyMs: 200 };
  }
  report.directoryCards = await evaluate(cdp, CARD_SUMMARY);
  report.readinessAtDirectory = {};
  for (const id of ["claude-code", "grokbuild", "opencode", "codex"]) report.readinessAtDirectory[id] = await evaluate(cdp, INVOKE("get_agent_install_readiness", { agentId: id }));
  report.toolVersionsAtDirectory = await evaluate(cdp, INVOKE("get_tool_versions", {}));

  for (const name of agents) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const product = { name, startedAt: new Date().toISOString() };
    // Never start a product while another card still shows a running job.
    for (let k = 0; k < 20 && (await evaluate(cdp, ANY_BUSY)); k += 1) await sleep(15000);
    await rescan();
    product.before = await evaluate(cdp, CARD_TEXT(name));
    const s1 = await step(`${slug}-oneclick`, CLICK_IN_CARD(name, "一键安装"));
    product.oneClick = s1.action;
    if (s1.action !== "clicked") {
      product.result = `未提供一键安装：${s1.action}`;
      report.products.push(product);
      continue;
    }
    product.confirmationDialog = s1.dialog ?? null;
    // Expand "查看本次安装包来源" so the exact download entry is recorded.
    product.sourceDisclosure = await evaluate(cdp, `(() => { document.querySelectorAll("[role=dialog] details, [role=alertdialog] details").forEach((d) => { d.open = true; }); return [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].map((d) => d.innerText + "\\n" + [...d.querySelectorAll("a[href]")].map((a) => a.href).join("\\n")).join("\\n---\\n").slice(0, 4000); })()`);
    const s2 = await step(`${slug}-confirm`, CLICK_TEXT("确认安装"), 10000);
    product.confirm = s2.action;
    // Vendor GUI installers (FyAgent says "请在官方窗口完成安装"): act as the
    // user in that official wizard through UI Automation, then let FyAgent re-detect.
    if (/官方窗口|官方安装窗口/.test(product.confirmationDialog ?? "") && process.env.SMOKE_E2E_DRIVE_WIZARDS !== "0") {
      await sleep(20000);
      await step(`${slug}-wizard-open`, null, 500);
      try {
        execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "wizard.ps1"), "-Out", out, "-Tag", slug, "-TimeoutS", "300"], { timeout: 330000 });
      } catch (error) {
        product.wizardError = String(error).slice(0, 500);
      }
      product.wizard = `wizard-${slug}.json`;
      await step(`${slug}-wizard-done`, null, 500);
    }
    const deadline = Date.now() + waitS * 1000;
    let last = null;
    let i = 0;
    while (Date.now() < deadline) {
      await sleep(20000);
      i += 1;
      last = await evaluate(cdp, CARD_TEXT(name));
      const busy = await evaluate(cdp, CARD_BUSY(name));
      const dialogOpen = await evaluate(cdp, `document.querySelectorAll("[role=dialog], [role=alertdialog]").length`);
      if (i % 3 === 0) await step(`${slug}-wait${i}`, null, 500);
      if (!busy && !dialogOpen && last && !/正在/.test(last)) break;
    }
    const s3 = await step(`${slug}-settled`, null, 2000);
    product.after = last;
    product.afterDialog = s3.dialog ?? null;
    if (name === "Codex") product.codexJob = await evaluate(cdp, INVOKE("codex_desktop_get_job"));
    product.finishedAt = new Date().toISOString();
    report.products.push(product);
    // Close a lingering dialog only; never press a card's job "取消".
    await evaluate(cdp, `(() => { const d = document.querySelector("[role=dialog], [role=alertdialog]"); if (!d) return "none"; const b = [...d.querySelectorAll("button")].find((x) => ["关闭", "取消", "完成", "知道了"].includes((x.innerText || "").trim())); if (b) { b.click(); return "closed"; } return "no button"; })()`);
  }
  await rescan();
  await step("rescan", null, 12000);
  report.finalDirectoryText = await evaluate(cdp, "document.body.innerText.slice(0, 20000)");
  report.finalCards = await evaluate(cdp, CARD_SUMMARY);
  report.codexJobFinal = await evaluate(cdp, INVOKE("codex_desktop_get_job"));
  report.codexLocalStatus = await evaluate(cdp, INVOKE("codex_desktop_get_local_status"));
  report.ok = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  cdp?.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, "e2e.json"), JSON.stringify(report, null, 2));
}
