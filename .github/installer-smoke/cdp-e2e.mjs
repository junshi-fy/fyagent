// Windows only: drive the installed FyAgent like a first-time user through the
// WebView2 DevTools protocol. Onboarding -> "编程开发" -> all software -> for
// each product card press FyAgent's own "一键安装" and "确认安装", then wait and
// screenshot (webview + desktop) until the card settles.
// Usage: node cdp-e2e.mjs   Env: SMOKE_OUT, SMOKE_CDP_PORT, SMOKE_E2E_AGENTS, SMOKE_E2E_WAIT_S
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, evaluate, findTarget, sleep } from "./cdp-lib.mjs";

const out = process.env.SMOKE_OUT ?? "smoke-out";
const port = Number(process.env.SMOKE_CDP_PORT ?? 9222);
const agents = (process.env.SMOKE_E2E_AGENTS ?? "Claude Code,OpenCode,Codex,Grok Build,QoderWork CN,TRAE Work CN,WorkBuddy").split(",");
const waitS = Number(process.env.SMOKE_E2E_WAIT_S ?? 300);
mkdirSync(out, { recursive: true });
const report = { scenario: "fyagent-e2e", startedAt: new Date().toISOString(), steps: [] };
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

const CLICK_TEXT = (text) => `(() => {
  const want = ${JSON.stringify(text)};
  const vis = (n) => n.offsetParent !== null || n.getClientRects().length > 0;
  const nodes = [...document.querySelectorAll("button, a, [role=button]")].filter((n) => vis(n) && (n.innerText || n.getAttribute("aria-label") || "").trim() === want && !n.disabled);
  if (!nodes.length) return "NOT FOUND";
  nodes[nodes.length - 1].click();
  return "clicked";
})()`;

// Click the button labelled `button` inside the smallest container that also
// contains the product heading `name`.
const CLICK_IN_CARD = (name, button) => `(() => {
  const vis = (n) => n.offsetParent !== null || n.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll("button")].filter((b) => vis(b) && (b.innerText || "").trim() === ${JSON.stringify(button)});
  let best = null;
  for (const b of buttons) {
    let a = b.parentElement;
    for (let i = 0; a && i < 10; i += 1, a = a.parentElement) {
      const heads = [...a.querySelectorAll("h2, h3, h4, strong, [class*=title], [class*=name]")].map((h) => (h.innerText || "").trim());
      if (heads.includes(${JSON.stringify(name)})) {
        const len = (a.innerText || "").length;
        if (!best || len < best.len) best = { b, len, disabled: b.disabled };
        break;
      }
    }
  }
  if (!best) return "NOT FOUND";
  if (best.disabled) return "DISABLED";
  best.b.scrollIntoView({ block: "center" });
  best.b.click();
  return "clicked";
})()`;

const CARD_TEXT = (name) => `(() => {
  const heads = [...document.querySelectorAll("h2, h3, h4")].filter((h) => (h.innerText || "").trim() === ${JSON.stringify(name)});
  if (!heads.length) return null;
  let a = heads[0];
  for (let i = 0; i < 6 && a.parentElement; i += 1) { a = a.parentElement; if ((a.innerText || "").length > 60) break; }
  return (a.innerText || "").slice(0, 1500);
})()`;

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
  await step("pick-coding", CLICK_TEXT("编程开发"));
  const all = await step("view-all", CLICK_TEXT("查看全部软件"));
  if (all.action !== "clicked") await step("skip-guide", CLICK_TEXT("跳过引导"));
  await step("directory", `location.hash = "#/agents"; "ok"`);
  report.directoryText = await evaluate(cdp, "document.body.innerText.slice(0, 20000)");

  for (const name of agents) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const product = { name, startedAt: new Date().toISOString() };
    await evaluate(cdp, `location.hash = "#/agents"; true`);
    await sleep(3000);
    product.before = await evaluate(cdp, CARD_TEXT(name));
    const s1 = await step(`${slug}-oneclick`, CLICK_IN_CARD(name, "一键安装"));
    product.oneClick = s1.action;
    if (s1.action !== "clicked") {
      product.result = `一键安装 ${s1.action}`;
      report.products = [...(report.products ?? []), product];
      continue;
    }
    product.confirmationDialog = s1.dialog ?? null;
    // Expand "查看本次安装包来源" so the exact download entry is recorded.
    product.sourceDisclosure = await evaluate(cdp, `(() => { document.querySelectorAll("[role=dialog] details, [role=alertdialog] details").forEach((d) => { d.open = true; }); return [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].map((d) => d.innerText + "\\n" + [...d.querySelectorAll("a[href]")].map((a) => a.href).join("\\n")).join("\\n---\\n").slice(0, 4000); })()`);
    const s2 = await step(`${slug}-confirm`, CLICK_TEXT("确认安装"), 10000);
    product.confirm = s2.action;
    const deadline = Date.now() + waitS * 1000;
    let last = null;
    let i = 0;
    while (Date.now() < deadline) {
      await sleep(30000);
      i += 1;
      last = await evaluate(cdp, CARD_TEXT(name));
      const dialogOpen = await evaluate(cdp, `document.querySelectorAll("[role=dialog], [role=alertdialog]").length`);
      if (i % 2 === 0) await step(`${slug}-wait${i}`, null, 500);
      if (last && !/正在|安装中|下载中|准备|检查中|等待/.test(last) && !dialogOpen) break;
    }
    const s3 = await step(`${slug}-settled`, null, 2000);
    product.after = last;
    product.afterDialog = s3.dialog ?? null;
    product.finishedAt = new Date().toISOString();
    report.products = [...(report.products ?? []), product];
    // Close any lingering dialog before the next product.
    await evaluate(cdp, CLICK_TEXT("关闭"));
    await evaluate(cdp, CLICK_TEXT("取消"));
  }
  await step("rescan", `location.hash = "#/agents"; setTimeout(() => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === "重新扫描"); b && b.click(); }, 500); "ok"`, 20000);
  report.finalDirectoryText = await evaluate(cdp, "document.body.innerText.slice(0, 20000)");
  report.ok = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  cdp?.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out, "e2e.json"), JSON.stringify(report, null, 2));
}
