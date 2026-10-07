export const TEST_UPDATER_KEY_ID: string;
export const UPDATER_PLATFORMS: readonly string[];
export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}
export interface UpdaterManifestInput {
  version: string;
  notes: string;
  pubDate: string;
  baseUrl: string;
  signatures: Record<string, string>;
  pubkey: string;
}
export function normalizeMirrorBaseUrl(value: string): string;
export function updaterPackageNames(version: string): string[];
export function updaterArtifactNames(version: string): string[];
export function decodeMinisign(
  value: string,
  kind: "publicKey" | "signature",
): {
  keyId: string;
  packet: Buffer;
  trustedComment?: string;
  globalSignature?: Buffer;
};
export function assertFormalUpdaterPublicKey(
  pubkey: string,
): ReturnType<typeof decodeMinisign>;
export function assertUpdaterSignatureKey(
  signature: string,
  pubkey: string,
): ReturnType<typeof decodeMinisign>;
export function buildUpdaterManifest(
  input: UpdaterManifestInput,
): UpdaterManifest;
export function validateUpdaterManifest(
  manifest: unknown,
  expected: UpdaterManifestInput,
): UpdaterManifest;
