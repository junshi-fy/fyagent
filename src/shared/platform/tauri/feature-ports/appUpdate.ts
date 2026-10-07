import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppUpdateCheck,
  AppUpdatePort,
  AppUpdateProgress,
} from "../../../features/app-update/types";
import { hasExactKeys, isRecord } from "./validation";

const INVALID_REPLY = "更新服务返回的数据无效，请打开下载页手动更新。";
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error(INVALID_REPLY);
  }
  return value;
}

function version(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || !VERSION.test(value))
    throw new Error(INVALID_REPLY);
  return value;
}

function nullableString(value: unknown): string | null {
  if (value !== null && typeof value !== "string")
    throw new Error(INVALID_REPLY);
  return value;
}

function parseCheck(value: unknown): AppUpdateCheck {
  const reply = record(value, ["currentVersion", "update"]);
  const update =
    reply.update === null
      ? null
      : record(reply.update, ["version", "notes", "date"]);
  return {
    currentVersion: version(reply.currentVersion),
    update: update
      ? {
          version: version(update.version),
          notes: nullableString(update.notes),
          date: nullableString(update.date),
        }
      : null,
  };
}

function parseProgress(value: unknown): AppUpdateProgress {
  const reply = record(value, ["downloaded", "total", "phase"]);
  if (
    typeof reply.downloaded !== "number" ||
    !Number.isSafeInteger(reply.downloaded) ||
    reply.downloaded < 0 ||
    (reply.total !== null &&
      (typeof reply.total !== "number" ||
        !Number.isSafeInteger(reply.total) ||
        reply.total < 0)) ||
    (reply.phase !== "downloading" && reply.phase !== "installing")
  ) {
    throw new Error(INVALID_REPLY);
  }
  return {
    downloaded: reply.downloaded,
    total: reply.total,
    phase: reply.phase,
  };
}

export function createAppUpdatePort(): AppUpdatePort {
  return {
    check: async () => parseCheck(await invoke<unknown>("check_app_update")),
    install: async (expectedVersion) => {
      await invoke("install_app_update", { version: version(expectedVersion) });
    },
    subscribeProgress: async (listener) =>
      listen<unknown>("app-update-progress", (event) => {
        try {
          listener(parseProgress(event.payload));
        } catch {
          console.warn("已忽略无效的应用更新进度事件");
        }
      }),
  };
}
