import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildUpdaterManifest,
  decodeMinisign,
  validateUpdaterManifest,
} from "../scripts/release/updater-manifest.mjs";
import { verifyUpdaterFile } from "../scripts/release/updater-release.mjs";

// 签名干跑：没有正式私钥时，用锁定版本的 Tauri CLI 临时生成一次性密钥，
// 按发版流水线同样的环境变量（TAURI_PRIVATE_KEY / TAURI_PRIVATE_KEY_PASSWORD）
// 签名，再用发版脚本的验签和清单校验走一遍。密钥只在系统临时目录里，测试结束即删除。
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const tauriCli = path.join(
  repositoryRoot,
  "node_modules/@tauri-apps/cli/tauri.js",
);
const version = "9.8.7";
const names = [
  `FyAgent-${version}-Windows-x64-setup.exe`,
  `FyAgent-${version}-Windows-arm64-setup.exe`,
  `FyAgent-${version}-macOS-universal.app.tar.gz`,
];

let root = "";
let pubkey = "";
const signatures: Record<string, string> = {};

function runTauri(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [tauriCli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", ...extra };
  for (const name of Object.keys(env)) {
    if (name.startsWith("TAURI_") && !(name in extra)) delete env[name];
  }
  return env;
}

describe("updater signing dry run with a throwaway key", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "fyagent-sign-dry-run-"));
    const password = `dry-run-${process.pid}-${Date.now()}`;
    const keyPath = path.join(root, "throwaway.key");
    runTauri(
      ["signer", "generate", "--ci", "-p", password, "-w", keyPath],
      cleanEnv(),
    );
    pubkey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const privateKey = readFileSync(keyPath, "utf8").trim();
    for (const [index, name] of names.entries()) {
      const file = path.join(root, name);
      writeFileSync(file, `fake final bytes ${index} for ${name}\n`);
      // Same variable names as the sign-updates-formal step after secret mapping.
      runTauri(
        ["signer", "sign", file],
        cleanEnv({
          TAURI_PRIVATE_KEY: privateKey,
          TAURI_PRIVATE_KEY_PASSWORD: password,
        }),
      );
      signatures[name] = readFileSync(`${file}.sig`, "utf8");
    }
  }, 300_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("signs every package with the key that tauri.conf.json would carry", () => {
    const keyId = decodeMinisign(pubkey, "publicKey").keyId;
    expect(keyId).not.toBe("B24D446F5B80F951");
    for (const name of names) {
      expect(statSync(path.join(root, `${name}.sig`)).size).toBeGreaterThan(0);
      expect(decodeMinisign(signatures[name], "signature").keyId).toBe(keyId);
    }
  });

  it("verifies final bytes and rejects any changed byte", async () => {
    for (const name of names) {
      await verifyUpdaterFile(path.join(root, name), signatures[name], pubkey);
    }
    const tampered = path.join(root, "tampered.exe");
    writeFileSync(tampered, "fake final bytes 0 for tampered\n");
    await expect(
      verifyUpdaterFile(tampered, signatures[names[0]], pubkey),
    ).rejects.toThrow(/does not verify final bytes/);
  });

  it("builds and gates latest.json from the dry-run signatures", () => {
    const expected = {
      version,
      notes: "Dry run notes",
      pubDate: "2026-10-08T00:00:00.000Z",
      baseUrl: "https://example.invalid/fyagent",
      signatures,
      pubkey,
    };
    const manifest = buildUpdaterManifest(expected);
    expect(validateUpdaterManifest(manifest, expected)).toBe(manifest);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    const missing = { ...signatures };
    delete missing[names[1]];
    expect(() =>
      buildUpdaterManifest({ ...expected, signatures: missing }),
    ).toThrow(/exactly all three packages/);
  });
});
