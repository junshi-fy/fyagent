#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sha256File } from "./release-contract.mjs";
import {
  assertFormalUpdaterPublicKey,
  assertUpdaterSignatureKey,
  buildUpdaterManifest,
  normalizeMirrorBaseUrl,
  updaterPackageNames,
  validateUpdaterManifest,
} from "./updater-manifest.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readInput(directory, version, baseUrl, pubDate) {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  assert(
    config.bundle.createUpdaterArtifacts === false,
    "Build-time updater signing must remain disabled",
  );
  const signatures = Object.fromEntries(
    updaterPackageNames(version).map((name) => [
      name,
      readFileSync(join(directory, `${name}.sig`), "utf8"),
    ]),
  );
  return {
    version,
    baseUrl,
    pubDate,
    signatures,
    notes: readFileSync(`docs/release-notes/v${version}-en.md`, "utf8"),
    pubkey: config.plugins.updater.pubkey,
  };
}

export async function verifyUpdaterFile(file, signature, pubkey) {
  const key = assertFormalUpdaterPublicKey(pubkey);
  const signed = assertUpdaterSignatureKey(signature, pubkey);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.packet.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const digest = createHash("blake2b512");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const signatureBytes = signed.packet.subarray(10);
  assert(
    verify(null, digest.digest(), publicKey, signatureBytes),
    "Updater signature does not verify final bytes",
  );
  assert(
    verify(
      null,
      Buffer.concat([signatureBytes, Buffer.from(signed.trustedComment)]),
      publicKey,
      signed.globalSignature,
    ),
    "Updater trusted comment signature is invalid",
  );
}

export function validateUpdaterEligibility(env, config) {
  for (const name of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ]) {
    assert(
      env[`${name}_CONFIGURED`] === "true",
      `Formal release requires secrets.${name}`,
    );
  }
  assertFormalUpdaterPublicKey(config.plugins?.updater?.pubkey);
  assert(
    config.bundle?.createUpdaterArtifacts === false,
    "Build-time updater signing must remain disabled",
  );
  const base = normalizeMirrorBaseUrl(env.FYAGENT_UPDATE_MIRROR_BASE_URL ?? "");
  if (base) {
    for (const name of [
      "S3_ENDPOINT",
      "S3_BUCKET",
      "ACCESS_KEY_ID",
      "SECRET_ACCESS_KEY",
    ]) {
      const secret = `FYAGENT_UPDATE_MIRROR_${name}`;
      assert(
        env[`${secret}_CONFIGURED`] === "true",
        `Configured mirror requires secrets.${secret}`,
      );
    }
  }
  return base;
}

function curlDownload(url, file) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === "https:" && !parsed.username && !parsed.password,
    "Readback requires public HTTPS",
  );
  parsed.searchParams.set(
    "fyagent_verify",
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const result = spawnSync(
    "curl",
    [
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--connect-timeout",
      "15",
      "--max-time",
      "300",
      "--header",
      "Cache-Control: no-cache",
      "--output",
      file,
      parsed.href,
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 310_000 },
  );
  assert(
    !result.error && result.status === 0,
    "Public updater readback download failed",
  );
}

export async function verifyUpdaterReadback({
  directory,
  expected,
  manifestUrl,
  download = curlDownload,
  delay = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  // Validate the local expected contract before fetching anything.
  const manifest = buildUpdaterManifest(expected);
  const hashes = new Map();
  for (const name of updaterPackageNames(expected.version))
    hashes.set(name, await sha256File(join(directory, name)));
  const root = mkdtempSync(join(tmpdir(), "fyagent-updater-readback-"));
  try {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const manifestFile = join(root, "latest.json");
        await download(manifestUrl, manifestFile);
        validateUpdaterManifest(
          JSON.parse(readFileSync(manifestFile, "utf8")),
          expected,
        );
        for (const name of hashes.keys()) {
          const entry = Object.values(manifest.platforms).find(({ url }) =>
            url.endsWith(`/${name}`),
          );
          const downloaded = join(root, name);
          await download(entry.url, downloaded);
          assert(
            (await sha256File(downloaded)) === hashes.get(name),
            `Updater readback SHA-256 mismatch: ${name}`,
          );
          const sigFile = join(root, `${name}.sig`);
          await download(`${entry.url}.sig`, sigFile);
          assert(
            readFileSync(sigFile, "utf8") === expected.signatures[name],
            `Updater readback .sig mismatch: ${name}`,
          );
        }
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await delay(5_000);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(argv) {
  const [command, directory, version, baseUrl, pubDate, destination] = argv;
  if (command === "eligibility" && argv.length === 2) {
    const base = validateUpdaterEligibility(
      process.env,
      JSON.parse(readFileSync(directory, "utf8")),
    );
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `mirror_base_url=${base}\n`, {
        flag: "a",
      });
    return;
  }
  assert(
    ["create", "verify-local", "readback"].includes(command) &&
      argv.length === (command === "verify-local" ? 5 : 6),
    "Invalid updater-release command arguments",
  );
  const expected = readInput(directory, version, baseUrl, pubDate);
  if (command === "create") {
    writeFileSync(
      destination,
      `${JSON.stringify(buildUpdaterManifest(expected), null, 2)}\n`,
      { flag: "wx" },
    );
  } else if (command === "verify-local") {
    validateUpdaterManifest(
      JSON.parse(readFileSync(join(directory, "latest.json"), "utf8")),
      expected,
    );
    for (const name of updaterPackageNames(version))
      await verifyUpdaterFile(
        join(directory, name),
        expected.signatures[name],
        expected.pubkey,
      );
  } else {
    await verifyUpdaterReadback({
      directory,
      expected,
      manifestUrl: destination,
    });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
