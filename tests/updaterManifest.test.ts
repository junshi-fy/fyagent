import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFormalUpdaterPublicKey,
  assertUpdaterSignatureKey,
  buildUpdaterManifest,
  decodeMinisign,
  normalizeMirrorBaseUrl,
  validateUpdaterManifest,
  type UpdaterManifestInput,
} from "../scripts/release/updater-manifest.mjs";
import {
  validateUpdaterEligibility,
  verifyUpdaterFile,
  verifyUpdaterReadback,
} from "../scripts/release/updater-release.mjs";
import { uploadUpdaterMirror } from "../scripts/release/sync-updater-mirror.mjs";

// These are deliberately invalid zero-filled packets, not generated keys or real signatures.
function fakeMinisign(
  kind: "publicKey" | "signature",
  id = "0123456789ABCDEF",
  label = "FAKE TEST ONLY",
) {
  const packet = Buffer.alloc(kind === "publicKey" ? 42 : 74);
  packet.write(kind === "publicKey" ? "Ed" : "ED");
  Buffer.from(id, "hex").reverse().copy(packet, 2);
  const lines = [
    "untrusted comment: FAKE ZERO PACKET - NOT A VALID KEY OR SIGNATURE",
    packet.toString("base64"),
  ];
  if (kind === "signature")
    lines.push(
      `trusted comment: ${label}`,
      Buffer.alloc(64).toString("base64"),
    );
  return Buffer.from(lines.join("\n") + "\n").toString("base64");
}

const pubkey = fakeMinisign("publicKey");
const signature = fakeMinisign("signature");
const x64Signature = fakeMinisign("signature", "0123456789ABCDEF", "FAKE X64");
const arm64Signature = fakeMinisign(
  "signature",
  "0123456789ABCDEF",
  "FAKE ARM64",
);
const macosSignature = fakeMinisign(
  "signature",
  "0123456789ABCDEF",
  "FAKE UNIVERSAL",
);
const x64 = "FyAgent-1.2.3-Windows-x64-setup.exe";
const arm64 = "FyAgent-1.2.3-Windows-arm64-setup.exe";
const macos = "FyAgent-1.2.3-macOS-universal.app.tar.gz";
const input: UpdaterManifestInput = {
  version: "1.2.3",
  notes: "Release notes\n",
  pubDate: "2026-10-08T00:00:00.000Z",
  baseUrl: "https://github.com/fy-agent/fyagent/releases/download/v1.2.3",
  signatures: {
    [x64]: x64Signature,
    [arm64]: arm64Signature,
    [macos]: macosSignature,
  },
  pubkey,
};
const expected = {
  version: "1.2.3",
  notes: "Release notes\n",
  pub_date: "2026-10-08T00:00:00.000Z",
  platforms: {
    "windows-x86_64": {
      signature: x64Signature,
      url: "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-Windows-x64-setup.exe",
    },
    "windows-aarch64": {
      signature: arm64Signature,
      url: "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-Windows-arm64-setup.exe",
    },
    "darwin-aarch64": {
      signature: macosSignature,
      url: "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-macOS-universal.app.tar.gz",
    },
    "darwin-x86_64": {
      signature: macosSignature,
      url: "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-macOS-universal.app.tar.gz",
    },
  },
};
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("formal updater manifest", () => {
  it("emits the explicit four-platform Tauri v2 static contract", () => {
    expect(buildUpdaterManifest(input)).toEqual(expected);
    expect(validateUpdaterManifest(expected, input)).toEqual(expected);
  });
  it("emits the explicit mirror URLs without inventing a provider", () => {
    const manifest = buildUpdaterManifest({
      ...input,
      baseUrl: "https://mirror.example.invalid/releases/",
    });
    expect(manifest.platforms).toEqual({
      "windows-x86_64": {
        signature: x64Signature,
        url: "https://mirror.example.invalid/releases/FyAgent-1.2.3-Windows-x64-setup.exe",
      },
      "windows-aarch64": {
        signature: arm64Signature,
        url: "https://mirror.example.invalid/releases/FyAgent-1.2.3-Windows-arm64-setup.exe",
      },
      "darwin-aarch64": {
        signature: macosSignature,
        url: "https://mirror.example.invalid/releases/FyAgent-1.2.3-macOS-universal.app.tar.gz",
      },
      "darwin-x86_64": {
        signature: macosSignature,
        url: "https://mirror.example.invalid/releases/FyAgent-1.2.3-macOS-universal.app.tar.gz",
      },
    });
  });
  it.each([
    "missing platform",
    "extra platform",
    "signature",
    "version",
    "url",
    "http",
    "notes",
    "date",
    "extra field",
  ])("rejects %s drift", (change) => {
    const manifest = structuredClone(expected);
    const platform = manifest.platforms["windows-x86_64"];
    if (change === "missing platform")
      delete (manifest.platforms as Record<string, unknown>)["darwin-x86_64"];
    if (change === "extra platform")
      (manifest.platforms as Record<string, unknown>).unexpected = platform;
    if (change === "signature") platform.signature = "FAKE MISMATCH";
    if (change === "version") manifest.version = "1.2.2";
    if (change === "url")
      platform.url = "https://wrong.example.invalid/file.exe";
    if (change === "http")
      platform.url = "http://mirror.example.invalid/file.exe";
    if (change === "notes") manifest.notes = "stale notes";
    if (change === "date") manifest.pub_date = "2026-10-07T00:00:00.000Z";
    if (change === "extra field")
      (manifest as Record<string, unknown>).unexpected = true;
    expect(() => validateUpdaterManifest(manifest, input)).toThrow();
  });
  it.each([
    "http://mirror.example.invalid",
    "https://user:password@mirror.example.invalid",
    "https://mirror.example.invalid/?query=1",
    "https://mirror.example.invalid/#fragment",
    " https://mirror.example.invalid",
  ])("rejects unsafe base %s", (baseUrl) => {
    expect(() => buildUpdaterManifest({ ...input, baseUrl })).toThrow();
  });
  it("rejects missing signatures, invalid versions, and malformed minisign", () => {
    expect(() =>
      buildUpdaterManifest({ ...input, signatures: { [x64]: signature } }),
    ).toThrow(/all three/);
    expect(() => buildUpdaterManifest({ ...input, version: "v1.2.3" })).toThrow(
      /version/,
    );
    expect(() =>
      assertUpdaterSignatureKey("FAKE NON-BASE64 SIGNATURE", pubkey),
    ).toThrow(/base64/);
    expect(() =>
      decodeMinisign(
        Buffer.from("untrusted comment: FAKE\nAAAA\n").toString("base64"),
        "publicKey",
      ),
    ).toThrow(/packet size/);
  });
  it("decodes little-endian key IDs, rejects mismatches and the test public key", () => {
    expect(decodeMinisign(pubkey, "publicKey").keyId).toBe("0123456789ABCDEF");
    expect(() =>
      assertUpdaterSignatureKey(
        fakeMinisign("signature", "FEDCBA9876543210"),
        pubkey,
      ),
    ).toThrow(/key ID/);
    expect(() =>
      assertFormalUpdaterPublicKey(
        fakeMinisign("publicKey", "B24D446F5B80F951"),
      ),
    ).toThrow("上线前必须换正式公钥");
  });
  it("keeps matching key IDs insufficient to authenticate final bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fyagent-fake-updater-"));
    temporary.push(root);
    const file = path.join(root, "fake.exe");
    writeFileSync(file, "FAKE PAYLOAD");
    await expect(verifyUpdaterFile(file, signature, pubkey)).rejects.toThrow(
      /final bytes/,
    );
  });
});

describe("formal updater configuration", () => {
  const config = {
    bundle: { createUpdaterArtifacts: false },
    plugins: { updater: { pubkey } },
  };
  const configured = {
    TAURI_SIGNING_PRIVATE_KEY_CONFIGURED: "true",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD_CONFIGURED: "true",
    FYAGENT_UPDATE_MIRROR_BASE_URL: "",
  };
  it("supports GitHub-only builds with no mirror credentials", () => {
    expect(validateUpdaterEligibility(configured, config)).toBe("");
    expect(normalizeMirrorBaseUrl("")).toBe("");
  });
  it.each(["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"])(
    "fails early on missing %s",
    (name) => {
      expect(() =>
        validateUpdaterEligibility(
          { ...configured, [`${name}_CONFIGURED`]: "false" },
          config,
        ),
      ).toThrow(`secrets.${name}`);
    },
  );
  it.each(["S3_ENDPOINT", "S3_BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"])(
    "requires mirror %s while allowing empty prefix",
    (name) => {
      const env: Record<string, string> = {
        ...configured,
        FYAGENT_UPDATE_MIRROR_BASE_URL: "https://mirror.example.invalid/",
      };
      for (const field of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "ACCESS_KEY_ID",
        "SECRET_ACCESS_KEY",
      ])
        env[`FYAGENT_UPDATE_MIRROR_${field}_CONFIGURED`] = "true";
      expect(validateUpdaterEligibility(env, config)).toBe(
        "https://mirror.example.invalid",
      );
      env[`FYAGENT_UPDATE_MIRROR_${name}_CONFIGURED`] = "false";
      expect(() => validateUpdaterEligibility(env, config)).toThrow(
        `secrets.FYAGENT_UPDATE_MIRROR_${name}`,
      );
    },
  );
});

describe("updater public readback", () => {
  function fixture() {
    const root = mkdtempSync(
      path.join(tmpdir(), "fyagent-updater-readback-test-"),
    );
    temporary.push(root);
    for (const name of [x64, arm64, macos])
      writeFileSync(path.join(root, name), `FAKE PAYLOAD: ${name}`);
    return root;
  }
  it("downloads each universal package once and verifies all public sig files", async () => {
    const directory = fixture();
    const calls: string[] = [];
    await verifyUpdaterReadback({
      directory,
      expected: input,
      manifestUrl: "https://mirror.example.invalid/latest.json",
      delay: async () => {},
      download: (url, file) => {
        calls.push(url);
        if (url.endsWith("latest.json"))
          writeFileSync(file, JSON.stringify(expected));
        else if (url.endsWith(".sig"))
          writeFileSync(
            file,
            input.signatures[path.basename(new URL(url).pathname).slice(0, -4)],
          );
        else
          writeFileSync(
            file,
            readFileSync(
              path.join(directory, path.basename(new URL(url).pathname)),
            ),
          );
      },
    });
    expect(calls).toEqual([
      "https://mirror.example.invalid/latest.json",
      "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-Windows-x64-setup.exe",
      "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-Windows-x64-setup.exe.sig",
      "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-Windows-arm64-setup.exe",
      "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-Windows-arm64-setup.exe.sig",
      "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-macOS-universal.app.tar.gz",
      "https://github.com/fy-agent/fyagent/releases/download/v1.2.3/FyAgent-1.2.3-macOS-universal.app.tar.gz.sig",
    ]);
  });
  it.each([
    "stale version",
    "wrong signature",
    "wrong url",
    "corrupt package",
    "corrupt sig",
    "network",
    "invalid JSON",
  ])("fails closed after bounded retries on %s", async (failure) => {
    const directory = fixture();
    let manifestReads = 0;
    let delays = 0;
    await expect(
      verifyUpdaterReadback({
        directory,
        expected: input,
        manifestUrl: "https://mirror.example.invalid/latest.json",
        delay: async () => {
          delays += 1;
        },
        download: (url, file) => {
          if (url.endsWith("latest.json")) {
            manifestReads += 1;
            if (failure === "network") throw new Error("FAKE NETWORK FAILURE");
            const manifest = structuredClone(expected);
            if (failure === "stale version") manifest.version = "1.2.2";
            if (failure === "wrong signature")
              manifest.platforms["darwin-x86_64"].signature = "FAKE MISMATCH";
            if (failure === "wrong url")
              manifest.platforms["windows-x86_64"].url =
                "https://wrong.example.invalid/file.exe";
            writeFileSync(
              file,
              failure === "invalid JSON"
                ? "FAKE INVALID JSON"
                : JSON.stringify(manifest),
            );
          } else if (url.endsWith(".sig"))
            writeFileSync(
              file,
              failure === "corrupt sig"
                ? "FAKE WRONG SIG"
                : input.signatures[
                    path.basename(new URL(url).pathname).slice(0, -4)
                  ],
            );
          else
            writeFileSync(
              file,
              failure === "corrupt package"
                ? "FAKE CORRUPTION"
                : readFileSync(
                    path.join(directory, path.basename(new URL(url).pathname)),
                  ),
            );
        },
      }),
    ).rejects.toThrow();
    expect(manifestReads).toBe(4);
    expect(delays).toBe(3);
  });
  it("recovers from a stale cache only when the full contract converges", async () => {
    const directory = fixture();
    let reads = 0;
    await verifyUpdaterReadback({
      directory,
      expected: input,
      manifestUrl: "https://mirror.example.invalid/latest.json",
      delay: async () => {},
      download: (url, file) => {
        if (url.endsWith("latest.json")) {
          reads += 1;
          writeFileSync(
            file,
            JSON.stringify({
              ...expected,
              version: reads === 1 ? "1.2.2" : "1.2.3",
            }),
          );
        } else if (url.endsWith(".sig"))
          writeFileSync(
            file,
            input.signatures[path.basename(new URL(url).pathname).slice(0, -4)],
          );
        else
          writeFileSync(
            file,
            readFileSync(
              path.join(directory, path.basename(new URL(url).pathname)),
            ),
          );
      },
    });
    expect(reads).toBe(2);
  });
});

describe("mirror S3 upload ordering", () => {
  const env = {
    FYAGENT_UPDATE_MIRROR_S3_ENDPOINT: "https://s3.example.invalid",
    FYAGENT_UPDATE_MIRROR_S3_BUCKET: "fake-bucket",
    FYAGENT_UPDATE_MIRROR_S3_PREFIX: "updates/",
    AWS_ACCESS_KEY_ID: "FAKE ACCESS ID",
    AWS_SECRET_ACCESS_KEY: "FAKE SECRET VALUE",
  };
  it("uploads exactly six payload files before latest.json using CLI env credentials", () => {
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      return { status: 0 };
    };
    uploadUpdaterMirror({
      directory: "attachments",
      version: "1.2.3",
      manifestPath: "mirror-latest.json",
      env,
      run,
    });
    expect(calls.map((args) => args[3])).toEqual([
      "s3://fake-bucket/updates/FyAgent-1.2.3-Windows-x64-setup.exe",
      "s3://fake-bucket/updates/FyAgent-1.2.3-Windows-x64-setup.exe.sig",
      "s3://fake-bucket/updates/FyAgent-1.2.3-Windows-arm64-setup.exe",
      "s3://fake-bucket/updates/FyAgent-1.2.3-Windows-arm64-setup.exe.sig",
      "s3://fake-bucket/updates/FyAgent-1.2.3-macOS-universal.app.tar.gz",
      "s3://fake-bucket/updates/FyAgent-1.2.3-macOS-universal.app.tar.gz.sig",
      "s3://fake-bucket/updates/latest.json",
    ]);
    expect(JSON.stringify(calls)).not.toContain("FAKE SECRET VALUE");
  });
  it("never uploads latest.json after any failed payload upload", () => {
    let count = 0;
    const run = () => {
      count += 1;
      return { status: count === 3 ? 1 : 0 };
    };
    expect(() =>
      uploadUpdaterMirror({
        directory: "attachments",
        version: "1.2.3",
        manifestPath: "mirror-latest.json",
        env,
        run,
      }),
    ).toThrow(/Mirror upload failed/);
    expect(count).toBe(3);
  });
  it("rejects missing credentials before calling aws", () => {
    let count = 0;
    const run = () => {
      count += 1;
      return { status: 0 };
    };
    expect(() =>
      uploadUpdaterMirror({
        directory: "attachments",
        version: "1.2.3",
        manifestPath: "mirror-latest.json",
        env: { ...env, AWS_SECRET_ACCESS_KEY: "" },
        run,
      }),
    ).toThrow(/FYAGENT_UPDATE_MIRROR_SECRET_ACCESS_KEY/);
    expect(count).toBe(0);
  });
});
