export type MirrorRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "ignore", "pipe"];
    timeout: number;
  },
) => { status: number | null; error?: Error };
export function uploadUpdaterMirror(input: {
  directory: string;
  version: string;
  manifestPath: string;
  env?: NodeJS.ProcessEnv;
  run?: MirrorRunner;
}): void;
