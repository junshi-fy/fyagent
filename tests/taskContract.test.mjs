import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("accepts a new task with usage without updating a parameterized task whitelist", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "fyagent-task-contract-"),
  );
  try {
    for (const relative of [
      ".mise",
      ".codex",
      "scripts/tasks",
      "mise.toml",
      "package.json",
    ]) {
      fs.cpSync(path.join(ROOT, relative), path.join(fixture, relative), {
        recursive: true,
      });
    }
    fs.symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(fixture, "node_modules"),
      "junction",
    );
    fs.appendFileSync(
      path.join(fixture, ".mise/tasks/core.toml"),
      `
["contract:usage:fixture"]
description = "Regression fixture for extensible parameter metadata"
usage = 'arg "<value>" help="Fixture argument"'
env.FYAGENT_TASK_EFFECT = "read-only"
run = "node --version"
`,
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/tasks/task-contract-check.mjs"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: fixture },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
