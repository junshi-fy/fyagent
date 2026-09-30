// Record which agent tools are actually present after a scenario, independent
// of FyAgent: `<bin> --version` from PATH and common per-user install dirs,
// plus macOS app bundles. Usage: node cli-versions.mjs <label>
import { execSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const label = process.argv[2] ?? "final";
const out = process.env.SMOKE_OUT ?? "smoke-out";
const win = process.platform === "win32";
const home = homedir();
const extraDirs = win
  ? [join(home, ".local", "bin"), join(process.env.APPDATA ?? "", "npm"), join(process.env.LOCALAPPDATA ?? "", "Programs")]
  : [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(home, ".npm-global", "bin")];
const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/).slice(0, 3).join(" ");
  } catch (error) {
    return null;
  }
};
const tools = ["claude", "codex", "opencode", "gemini", "grok", "openclaw"].map((bin) => {
  const where = run(win ? `where ${bin}` : `command -v ${bin}`);
  const version = run(`${bin} --version`);
  const extra = extraDirs
    .map((d) => join(d, win ? `${bin}.exe` : bin))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, version: run(`"${p}" --version`) }));
  return { bin, where, version, extra };
});
const apps = [];
if (process.platform === "darwin") {
  for (const dir of ["/Applications", join(home, "Applications")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => /opencode|codex|claude|qoder|trae|workbuddy|grok|fyagent/i.test(n))) {
      const plist = join(dir, name, "Contents", "Info.plist");
      apps.push({
        path: join(dir, name),
        bundleId: run(`/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${plist}"`),
        version: run(`/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${plist}"`),
      });
    }
  }
}
const report = { label, at: new Date().toISOString(), tools, apps };
writeFileSync(join(out, `cli-versions-${label}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
