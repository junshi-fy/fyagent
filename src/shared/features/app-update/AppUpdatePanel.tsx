import { Button } from "../../ui/Button";
import { useOpenExternal } from "../provider";
import { useAppUpdate } from "./provider";
import "./app-update-panel.css";

const DOWNLOAD_PAGE = "https://github.com/fy-agent/fyagent/releases";

function bytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** Ready for the About dialog; no mount means no additional native workflow. */
export function AppUpdatePanel() {
  const state = useAppUpdate();
  const { openExternal, openingUrl } = useOpenExternal();
  const installing = state.progress !== null;
  const blocked = state.checking || installing;
  const total = state.progress?.total;

  return (
    <section className="fy-app-update-panel" aria-label="应用内更新">
      <div className="fy-app-update-header">
        <div>
          <h3>应用更新</h3>
          <p>当前版本：{state.currentVersion ?? "暂时无法读取"}</p>
        </div>
        <Button disabled={blocked} onClick={() => void state.check()}>
          {state.checking ? "检查中…" : "检查更新"}
        </Button>
      </div>
      {state.update ? (
        <div className="fy-app-update-release">
          <p>
            新版本：{state.update.version}
            {state.isSkipped ? "（已跳过）" : ""}
          </p>
          {state.update.date ? <p>发布日期：{state.update.date}</p> : null}
          <p className="fy-app-update-notes">
            {state.update.notes || "此版本未提供更新说明。"}
          </p>
          <div className="fy-app-update-actions">
            <Button
              className="fy-app-update-primary"
              disabled={blocked}
              onClick={() => void state.install()}
            >
              {installing ? "更新中…" : "立即更新"}
            </Button>
            <Button
              disabled={blocked}
              onClick={
                state.isSkipped ? state.clearSkippedVersion : state.skipVersion
              }
            >
              {state.isSkipped ? "取消跳过" : "跳过这个版本"}
            </Button>
          </div>
        </div>
      ) : state.checked && !state.checking && !state.error ? (
        <p role="status">已是最新版本。</p>
      ) : null}
      {state.progress ? (
        <div role="status" aria-live="polite">
          {state.progress.phase === "installing" ? (
            <p>正在安装，完成后将自动重启…</p>
          ) : (
            <>
              <p>
                正在下载：{bytes(state.progress.downloaded)}
                {total !== null && total !== undefined
                  ? ` / ${bytes(total)}`
                  : ""}
              </p>
              <progress
                aria-label="更新下载进度"
                max={total && total > 0 ? total : undefined}
                value={
                  total && total > 0 ? state.progress.downloaded : undefined
                }
              />
            </>
          )}
        </div>
      ) : null}
      {state.error ? (
        <div>
          <p className="fy-app-update-error" role="alert">
            {state.error}
          </p>
          <Button
            disabled={openingUrl === DOWNLOAD_PAGE || installing}
            onClick={() => void openExternal(DOWNLOAD_PAGE)}
          >
            打开下载页
          </Button>
        </div>
      ) : null}
    </section>
  );
}
