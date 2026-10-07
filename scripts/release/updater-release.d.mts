import type { UpdaterManifestInput } from "./updater-manifest.mjs";
export function verifyUpdaterFile(
  file: string,
  signature: string,
  pubkey: string,
): Promise<void>;
export function validateUpdaterEligibility(
  env: Record<string, string | undefined>,
  config: unknown,
): string;
export function verifyUpdaterReadback(input: {
  directory: string;
  expected: UpdaterManifestInput;
  manifestUrl: string;
  download?: (url: string, file: string) => void | Promise<void>;
  delay?: (ms: number) => Promise<void>;
}): Promise<void>;
