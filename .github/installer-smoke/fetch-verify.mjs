// Download the official, already-published release assets for one platform and
// verify them against the release's download-manifest.json before any install.
// Nothing is rebuilt or repackaged. Exits non-zero on any mismatch.
//
// Env: SMOKE_REPO (owner/name), SMOKE_TAG (vX.Y.Z), SMOKE_PLATFORM (windows|macos),
//      SMOKE_ARCH (x64|arm64|universal), SMOKE_OUT
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.env.SMOKE_REPO ?? "fy-agent/fyagent";
const tag = process.env.SMOKE_TAG;
const platform = process.env.SMOKE_PLATFORM;
const arch = process.env.SMOKE_ARCH;
const out = process.env.SMOKE_OUT ?? "smoke-out";
const assetsDir = join(out, "assets");
mkdirSync(assetsDir, { recursive: true });

if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  throw new Error(`tag must look like vX.Y.Z, got ${tag}`);
}

const base = `https://github.com/${repo}/releases/download/${tag}`;

async function download(name) {
  const res = await fetch(`${base}/${name}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(assetsDir, name), buf);
  return buf;
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const manifestBuf = await download("download-manifest.json");
const manifest = JSON.parse(manifestBuf.toString("utf8"));
if (manifest.tag !== tag) throw new Error(`manifest tag ${manifest.tag} != ${tag}`);

const wanted = manifest.assets.filter(
  (a) => a.platform === platform && a.architecture === arch,
);
if (wanted.length !== 1) {
  throw new Error(`expected exactly one ${platform}/${arch} asset, found ${wanted.length}`);
}

// Optional cross-check: provenance bundle subjects (digest comparison only; the
// Sigstore signature itself is not verified here).
let provenanceSubjects = null;
try {
  const bundle = JSON.parse((await download("artifact-attestation.sigstore.json")).toString("utf8"));
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  provenanceSubjects = Object.fromEntries(
    statement.subject.map((s) => [s.name, s.digest?.sha256 ?? null]),
  );
} catch (error) {
  console.warn(`provenance bundle not read: ${error}`);
}

const checks = [];
let ok = true;
for (const asset of wanted) {
  const buf = await download(asset.name);
  const actual = sha256(buf);
  const shaMatch = actual === asset.sha256;
  const sizeMatch = buf.length === asset.sizeBytes;
  const provenance = provenanceSubjects?.[asset.name] ?? null;
  const provenanceMatch = provenance === null ? null : provenance === actual;
  ok &&= shaMatch && sizeMatch && provenanceMatch !== false;
  checks.push({
    name: asset.name,
    url: `${base}/${asset.name}`,
    manifestSha256: asset.sha256,
    actualSha256: actual,
    manifestSize: asset.sizeBytes,
    actualSize: buf.length,
    shaMatch,
    sizeMatch,
    provenanceSha256: provenance,
    provenanceMatch,
  });
}

const report = {
  repo,
  tag,
  manifestVersion: manifest.version,
  manifestSourceSha: manifest.sourceSha,
  manifestSha256: sha256(manifestBuf),
  manifestProvenanceMatch:
    provenanceSubjects?.["download-manifest.json"] == null
      ? null
      : provenanceSubjects["download-manifest.json"] === sha256(manifestBuf),
  checkedAt: new Date().toISOString(),
  ok,
  checks,
};
writeFileSync(join(out, "sha-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!ok) {
  console.error("SHA-256/size mismatch against the official manifest; refusing to install.");
  process.exit(1);
}
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `asset=${join(assetsDir, wanted[0].name)}\n`, { flag: "a" });
}
