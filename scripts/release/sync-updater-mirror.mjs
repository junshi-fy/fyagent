#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  updaterPackageNames,
  normalizeMirrorBaseUrl,
} from "./updater-manifest.mjs";

export function uploadUpdaterMirror({
  directory,
  version,
  manifestPath,
  env = process.env,
  run = spawnSync,
}) {
  const endpoint = normalizeMirrorBaseUrl(
    env.FYAGENT_UPDATE_MIRROR_S3_ENDPOINT ?? "",
  );
  if (!endpoint)
    throw new Error("Missing secrets.FYAGENT_UPDATE_MIRROR_S3_ENDPOINT");
  const bucket = env.FYAGENT_UPDATE_MIRROR_S3_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket))
    throw new Error("Invalid secrets.FYAGENT_UPDATE_MIRROR_S3_BUCKET");
  const prefix = env.FYAGENT_UPDATE_MIRROR_S3_PREFIX ?? "";
  if (
    prefix &&
    (!/^[A-Za-z0-9_./-]+$/u.test(prefix) ||
      prefix.split("/").some((part) => part === "." || part === ".."))
  )
    throw new Error("Invalid mirror S3 prefix");
  for (const [variable, secret] of [
    ["AWS_ACCESS_KEY_ID", "FYAGENT_UPDATE_MIRROR_ACCESS_KEY_ID"],
    ["AWS_SECRET_ACCESS_KEY", "FYAGENT_UPDATE_MIRROR_SECRET_ACCESS_KEY"],
  ]) {
    if (!env[variable]) throw new Error(`Missing secrets.${secret}`);
  }
  const root = `s3://${bucket}/${prefix.replace(/^\/+|\/+$/gu, "")}`.replace(
    /\/+$/u,
    "",
  );
  const packages = updaterPackageNames(version);
  const files = packages.flatMap((name) => [
    { name, file: join(directory, name) },
    { name: `${name}.sig`, file: join(directory, `${name}.sig`) },
  ]);
  // This mutable pointer is uploaded only after every payload and signature succeeds.
  files.push({ name: "latest.json", file: manifestPath });
  for (const { name, file } of files) {
    const result = run(
      "aws",
      [
        "s3",
        "cp",
        file,
        `${root}/${name}`,
        "--endpoint-url",
        endpoint,
        "--only-show-errors",
        "--no-progress",
        "--cache-control",
        "no-cache",
      ],
      { env, stdio: ["ignore", "ignore", "pipe"], timeout: 310_000 },
    );
    if (result.error || result.status !== 0)
      throw new Error(`Mirror upload failed: ${name}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [directory, version, manifestPath, ...extra] = process.argv.slice(2);
    if (!directory || !version || !manifestPath || extra.length)
      throw new Error(
        "Usage: sync-updater-mirror.mjs <attachments> <version> <mirror-manifest>",
      );
    uploadUpdaterMirror({ directory, version, manifestPath });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
