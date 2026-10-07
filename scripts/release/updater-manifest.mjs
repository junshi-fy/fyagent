import { assertWindowsBundleVersion } from "./release-contract.mjs";
import { updaterPackageNames } from "./release-contract.mjs";
export {
  updaterPackageNames,
  updaterArtifactNames,
} from "./release-contract.mjs";

export const TEST_UPDATER_KEY_ID = "B24D446F5B80F951";
export const UPDATER_PLATFORMS = Object.freeze([
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeMirrorBaseUrl(value) {
  assert(typeof value === "string", "Mirror BASE_URL must be a string");
  if (value === "") return "";
  const url = new URL(value);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      value === value.trim(),
    "Updater base URL must be public HTTPS without credentials, query or fragment",
  );
  return url.href.replace(/\/+$/u, "");
}

function decodeBase64(value, label) {
  assert(typeof value === "string", `${label} must be base64`);
  const text = value.trim();
  assert(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      text,
    ) && text.length > 0,
    `${label} must be canonical base64`,
  );
  const bytes = Buffer.from(text, "base64");
  assert(
    bytes.toString("base64") === text,
    `${label} must be canonical base64`,
  );
  return bytes;
}

export function decodeMinisign(value, kind) {
  assert(kind === "publicKey" || kind === "signature", "Unknown minisign kind");
  const lines = decodeBase64(value, kind)
    .toString("utf8")
    .trimEnd()
    .split(/\r?\n/u);
  assert(
    lines.length === (kind === "publicKey" ? 2 : 4) &&
      lines[0].startsWith("untrusted comment: "),
    `Invalid minisign ${kind} text`,
  );
  const packet = decodeBase64(lines[1], `${kind} packet`);
  assert(
    packet.length === (kind === "publicKey" ? 42 : 74),
    `Invalid minisign ${kind} packet size`,
  );
  const algorithm = packet.subarray(0, 2).toString("ascii");
  assert(
    kind === "publicKey" ? algorithm === "Ed" : algorithm === "ED",
    `Unsupported minisign ${kind} algorithm`,
  );
  let globalSignature;
  let trustedComment;
  if (kind === "signature") {
    assert(
      lines[2].startsWith("trusted comment: "),
      "Invalid minisign trusted comment",
    );
    trustedComment = lines[2].slice(17);
    globalSignature = decodeBase64(lines[3], "global signature");
    assert(
      globalSignature.length === 64,
      "Invalid minisign global signature size",
    );
  }
  return {
    keyId: Buffer.from(packet.subarray(2, 10))
      .reverse()
      .toString("hex")
      .toUpperCase(),
    packet,
    trustedComment,
    globalSignature,
  };
}

export function assertFormalUpdaterPublicKey(pubkey) {
  const key = decodeMinisign(pubkey, "publicKey");
  assert(
    key.keyId !== TEST_UPDATER_KEY_ID,
    "上线前必须换正式公钥（当前为测试公钥 B24D446F5B80F951）",
  );
  return key;
}

export function assertUpdaterSignatureKey(signature, pubkey) {
  const key = assertFormalUpdaterPublicKey(pubkey);
  const signed = decodeMinisign(signature, "signature");
  assert(
    signed.keyId === key.keyId,
    "Updater signature key ID does not match tauri.conf.json pubkey",
  );
  return signed;
}

export function buildUpdaterManifest({
  version,
  notes,
  pubDate,
  baseUrl,
  signatures,
  pubkey,
}) {
  assertWindowsBundleVersion(version);
  const names = updaterPackageNames(version);
  const base = normalizeMirrorBaseUrl(baseUrl);
  assert(base, "Updater base URL must not be empty");
  assert(
    typeof notes === "string" && notes.trim(),
    "Updater notes must not be empty",
  );
  assert(
    typeof pubDate === "string" &&
      !Number.isNaN(Date.parse(pubDate)) &&
      new Date(pubDate).toISOString() === pubDate,
    "Updater pub_date must be an ISO instant",
  );
  assert(
    signatures &&
      Object.keys(signatures).sort().join() === [...names].sort().join(),
    "Updater signatures must contain exactly all three packages",
  );
  for (const name of names) assertUpdaterSignatureKey(signatures[name], pubkey);
  const platforms = Object.fromEntries(
    UPDATER_PLATFORMS.map((platform, index) => {
      const name = names[Math.min(index, 2)];
      return [
        platform,
        { signature: signatures[name], url: `${base}/${name}` },
      ];
    }),
  );
  return { version, notes, pub_date: pubDate, platforms };
}

export function validateUpdaterManifest(manifest, expected) {
  const wanted = buildUpdaterManifest(expected);
  assert(
    manifest &&
      Object.keys(manifest).sort().join() ===
        "notes,platforms,pub_date,version",
    "Updater manifest must have exactly version, notes, pub_date, platforms",
  );
  for (const field of ["version", "notes", "pub_date"]) {
    assert(manifest[field] === wanted[field], `Updater ${field} mismatch`);
  }
  assert(
    manifest.platforms &&
      Object.keys(manifest.platforms).sort().join() ===
        [...UPDATER_PLATFORMS].sort().join(),
    "Updater platforms must contain exactly all four supported platforms",
  );
  for (const platform of UPDATER_PLATFORMS) {
    const entry = manifest.platforms[platform];
    assert(
      entry && Object.keys(entry).sort().join() === "signature,url",
      `Invalid updater platform ${platform}`,
    );
    assert(
      entry.signature === wanted.platforms[platform].signature,
      `Updater signature mismatch for ${platform}`,
    );
    assert(
      normalizeMirrorBaseUrl(entry.url) === entry.url,
      `Updater URL must be canonical HTTPS for ${platform}`,
    );
    assert(
      entry.url === wanted.platforms[platform].url,
      `Updater URL mismatch for ${platform}`,
    );
  }
  return manifest;
}
