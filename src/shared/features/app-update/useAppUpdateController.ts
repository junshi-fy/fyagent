import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppUpdatePort,
  AppUpdateProgress,
  AvailableAppUpdate,
} from "./types";

export const SKIPPED_APP_UPDATE_KEY = "fyagent:update:skippedVersion";
export const APP_UPDATE_STARTUP_DELAY = 8_000;
export const APP_UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1_000;

function readSkippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIPPED_APP_UPDATE_KEY);
  } catch {
    return null;
  }
}

function persistSkippedVersion(version: string | null): void {
  try {
    if (version === null) localStorage.removeItem(SKIPPED_APP_UPDATE_KEY);
    else localStorage.setItem(SKIPPED_APP_UPDATE_KEY, version);
  } catch {
    // A denied preference store must not disable checking or installing updates.
  }
}

function updateError(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  return typeof message === "string" && message.length > 0
    ? message
    : "更新失败，请稍后重试或打开下载页手动更新。";
}

/** Owns one application lifetime; manual checks also postpone automatic checks. */
export function useAppUpdateController(
  port: AppUpdatePort,
  getCurrentVersion: () => Promise<string>,
) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<AvailableAppUpdate | null>(null);
  const [skippedVersion, setSkippedVersion] = useState(readSkippedVersion);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const busy = useRef<"checking" | "installing" | null>(null);
  const lastCheck = useRef<number | null>(null);
  const mounted = useRef(false);
  const releaseProgress = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    void getCurrentVersion().then(
      (value) => {
        if (active) setCurrentVersion(value);
      },
      () => {
        // An unavailable package version must not produce a startup prompt.
      },
    );
    return () => {
      active = false;
      mounted.current = false;
      releaseProgress.current?.();
      releaseProgress.current = null;
    };
  }, [getCurrentVersion]);

  const check = useCallback(
    async (manual = true): Promise<void> => {
      if (busy.current !== null) return;
      if (
        !manual &&
        lastCheck.current !== null &&
        Date.now() - lastCheck.current < APP_UPDATE_CHECK_INTERVAL
      )
        return;
      busy.current = "checking";
      lastCheck.current = Date.now();
      setChecking(true);
      if (manual) setError(null);
      try {
        const result = await port.check();
        if (!mounted.current) return;
        setCurrentVersion(result.currentVersion);
        setUpdate(result.update);
        setChecked(true);
        if (manual) setError(null);
      } catch (failure) {
        if (manual && mounted.current) setError(updateError(failure));
        else console.warn("应用自动检查更新失败，将在下次检查时重试");
      } finally {
        if (mounted.current) setChecking(false);
        busy.current = null;
      }
    },
    [port],
  );

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await check(false);
      if (!active) return;
      const remaining =
        lastCheck.current === null
          ? APP_UPDATE_CHECK_INTERVAL
          : Math.max(
              1_000,
              APP_UPDATE_CHECK_INTERVAL - (Date.now() - lastCheck.current),
            );
      timer = setTimeout(() => void tick(), remaining);
    };
    timer = setTimeout(() => void tick(), APP_UPDATE_STARTUP_DELAY);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [check]);

  const skipVersion = useCallback(() => {
    if (!update) return;
    persistSkippedVersion(update.version);
    setSkippedVersion(update.version);
  }, [update]);

  const clearSkippedVersion = useCallback(() => {
    persistSkippedVersion(null);
    setSkippedVersion(null);
  }, []);

  const install = useCallback(async () => {
    if (!update || busy.current !== null) return;
    busy.current = "installing";
    setError(null);
    setProgress({ phase: "downloading", downloaded: 0, total: null });
    let unlisten: (() => void) | undefined;
    try {
      const nativeUnlisten = await port.subscribeProgress((value) => {
        if (mounted.current) setProgress(value);
      });
      let released = false;
      unlisten = () => {
        if (released) return;
        released = true;
        nativeUnlisten();
      };
      if (!mounted.current) return;
      releaseProgress.current = unlisten;
      await port.install(update.version);
      // A successful install exits/restarts natively. Keep controls locked until then.
      if (mounted.current)
        setProgress((value) => ({
          phase: "installing",
          downloaded: value?.downloaded ?? 0,
          total: value?.total ?? null,
        }));
    } catch (failure) {
      if (mounted.current) {
        setError(updateError(failure));
        setProgress(null);
      }
      busy.current = null;
    } finally {
      unlisten?.();
      if (releaseProgress.current === unlisten) releaseProgress.current = null;
    }
  }, [port, update]);

  return {
    currentVersion,
    update,
    checking,
    checked,
    error,
    progress,
    isSkipped: update !== null && skippedVersion === update.version,
    hasUpdate: update !== null && skippedVersion !== update.version,
    check,
    install,
    skipVersion,
    clearSkippedVersion,
  };
}
