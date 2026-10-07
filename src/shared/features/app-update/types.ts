export interface AvailableAppUpdate {
  version: string;
  notes: string | null;
  date: string | null;
}

export interface AppUpdateCheck {
  currentVersion: string;
  update: AvailableAppUpdate | null;
}

export interface AppUpdateProgress {
  downloaded: number;
  total: number | null;
  phase: "downloading" | "installing";
}

export interface AppUpdatePort {
  check(): Promise<AppUpdateCheck>;
  install(version: string): Promise<void>;
  subscribeProgress(
    listener: (progress: AppUpdateProgress) => void,
  ): Promise<() => void>;
}
