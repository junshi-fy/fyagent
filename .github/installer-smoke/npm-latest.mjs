// Read npm "latest" dist-tags live from the public registry at run time.
// Output: $SMOKE_OUT/npm-latest.json
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGES = [
  { tool: "codex", pkg: "@openai/codex" },
  { tool: "claude", pkg: "@anthropic-ai/claude-code" },
  { tool: "gemini", pkg: "@google/gemini-cli" },
  { tool: "opencode (legacy pkg)", pkg: "opencode-ai" },
  { tool: "opencode (v2 pkg)", pkg: "@opencode/cli" },
  { tool: "grok", pkg: "@xai-official/grok" },
  { tool: "openclaw", pkg: "openclaw" },
];

const out = process.env.SMOKE_OUT ?? "smoke-out";
mkdirSync(out, { recursive: true });

const readAt = new Date().toISOString();
const results = [];
for (const { tool, pkg } of PACKAGES) {
  const url = `https://registry.npmjs.org/-/package/${pkg.replace("/", "%2f")}/dist-tags`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = res.ok ? await res.json() : null;
    results.push({ tool, pkg, latest: body?.latest ?? null, status: res.status });
  } catch (error) {
    results.push({ tool, pkg, latest: null, error: String(error) });
  }
}
const report = { readAt, registry: "https://registry.npmjs.org", results };
writeFileSync(join(out, "npm-latest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
