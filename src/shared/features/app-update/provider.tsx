import { createContext, useContext, type ReactNode } from "react";
import { useFeatures } from "../provider";
import { useAppUpdateController } from "./useAppUpdateController";

const AppUpdateContext = createContext<ReturnType<
  typeof useAppUpdateController
> | null>(null);

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { ports } = useFeatures();
  const value = useAppUpdateController(
    ports.appUpdate,
    ports.settings.getAppVersion,
  );
  return (
    <AppUpdateContext.Provider value={value}>
      {children}
    </AppUpdateContext.Provider>
  );
}

export function useOptionalAppUpdate() {
  return useContext(AppUpdateContext);
}

export function useAppUpdate() {
  const context = useOptionalAppUpdate();
  if (!context) throw new Error("useAppUpdate requires AppUpdateProvider");
  return context;
}
