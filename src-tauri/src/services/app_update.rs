//! Signed application updates remain behind two narrow application commands.

#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Updater, UpdaterExt};
use url::Url;

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::codex_desktop::jobs::{ProcessLifecycleClaim, ProcessLifecycleTransition};

/// Managed only after plugin registration succeeds. UpdaterExt itself uses
/// `state()` and would panic if a failed registration left its state absent.
pub(crate) struct AppUpdaterAvailable;

const GITHUB_ENDPOINT: &str =
    "https://github.com/fy-agent/fyagent/releases/latest/download/latest.json";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const PROGRESS_EVENT: &str = "app-update-progress";
#[cfg(any(target_os = "windows", target_os = "macos"))]
static INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    current_version: String,
    update: Option<AppUpdateMetadata>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateMetadata {
    version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress {
    downloaded: u64,
    total: Option<u64>,
    phase: &'static str,
}

/// Updater 2.12.0 tries the next endpoint on network errors, non-2xx HTTP status
/// or RemoteRelease deserialization failure. HTTP 204 returns no update;
/// response JSON read/parse failures return immediately. A parsed manifest
/// missing the current platform target does not fall back either. A stale
/// mirror blocks GitHub, so releases must sync and verify the mirror first.
fn update_endpoints(mirror: Option<&str>) -> Vec<Url> {
    let github = Url::parse(GITHUB_ENDPOINT).expect("fixed GitHub update endpoint is HTTPS");
    let mirror = mirror
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
        });
    match mirror {
        Some(mirror) if mirror != github => vec![mirror, github],
        _ => vec![github],
    }
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    if app.try_state::<AppUpdaterAvailable>().is_none() {
        return Err("应用更新器暂不可用，请打开下载页手动更新。".to_owned());
    }
    // tauri.conf.json currently contains a TEST public key. Replace it with
    // the production public key before release and back up the private key.
    // The mirror is a build-time input; no renderer-controlled URL is accepted.
    app.updater_builder()
        .timeout(std::time::Duration::from_secs(300))
        .endpoints(update_endpoints(option_env!(
            "FYAGENT_UPDATE_MIRROR_ENDPOINT"
        )))
        .map_err(|error| format!("更新地址配置无效：{error}"))?
        .build()
        .map_err(|error| format!("初始化更新器失败，请打开下载页手动更新：{error}"))
}

pub(crate) async fn check(app: &AppHandle) -> Result<AppUpdateCheck, String> {
    let update = updater(app)?
        .check()
        .await
        .map_err(|error| format!("检查更新失败，请检查网络或打开下载页：{error}"))?;
    Ok(AppUpdateCheck {
        current_version: app.package_info().version.to_string(),
        update: update.map(|update| AppUpdateMetadata {
            version: update.version,
            notes: update.body,
            date: update.date.map(|date| date.to_string()),
        }),
    })
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
struct InstallFlight;

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl InstallFlight {
    fn claim() -> Result<Self, String> {
        INSTALL_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "应用更新正在进行，请等待完成。".to_owned())
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl Drop for InstallFlight {
    fn drop(&mut self) {
        INSTALL_IN_PROGRESS.store(false, Ordering::Release);
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
struct UpdateReservation {
    app: AppHandle,
    receipt: Option<crate::ProcessLifecycleClaimReceipt>,
    agent_jobs: Option<Arc<crate::agent_install::AgentActionJobStore>>,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl UpdateReservation {
    fn claim(app: &AppHandle) -> Result<Self, String> {
        let mut reservation = Self {
            app: app.clone(),
            receipt: None,
            agent_jobs: None,
        };
        if let Some(state) = app.try_state::<crate::AppState>() {
            state
                .agent_action_jobs
                .reserve_for_app_update()
                .map_err(|_| {
                    "Agent 安装或更新任务仍在运行，请等待任务结束后再更新应用。".to_owned()
                })?;
            reservation.agent_jobs = Some(Arc::clone(&state.agent_action_jobs));
        }
        let receipt =
            crate::claim_process_lifecycle_transition(app, ProcessLifecycleTransition::Update)
                .map_err(|_| {
                    "Codex Desktop 安装任务仍在运行，或应用正在退出、重启，暂时无法更新。"
                        .to_owned()
                })?;
        if receipt.claim != ProcessLifecycleClaim::StartCleanup(ProcessLifecycleTransition::Update)
        {
            return Err("应用正在退出、重启或更新，请等待完成后再试。".to_owned());
        }
        reservation.receipt = Some(receipt);
        Ok(reservation)
    }

    fn receipt(&self) -> crate::ProcessLifecycleClaimReceipt {
        self.receipt.expect("update reservation owns its receipt")
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl Drop for UpdateReservation {
    fn drop(&mut self) {
        if let Some(receipt) = self.receipt {
            if let Err(error) = crate::abort_app_update_transition(&self.app, receipt) {
                log::error!("{error}");
            }
        }
        if let Some(jobs) = &self.agent_jobs {
            jobs.release_app_update();
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn require_installers_idle(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<crate::AppState>() {
        if state.agent_action_jobs.has_active_job()
            || state
                .codex_desktop_service
                .get_job()
                .map_err(|_| "安装任务状态不可用，无法安全更新应用。".to_owned())?
                .is_some_and(|job| !job.stage.is_terminal())
        {
            return Err("安装或更新任务仍在运行，请等待任务结束后再更新应用。".to_owned());
        }
    }
    // This preflight reservation is immediately released. After download the
    // same writer is held through installation to close the start race.
    let _cli = super::tooling::reserve_cli_lifecycle_for_app_update()?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) async fn install(app: AppHandle, version: String) -> Result<(), String> {
    let flight = InstallFlight::claim()?;
    require_installers_idle(&app)?;
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("检查更新失败，请检查网络后重试：{error}"))?
        .ok_or_else(|| "没有可安装的新版本，请重新检查更新。".to_owned())?;
    if update.version != version {
        return Err("可用更新版本已变化，请重新检查并确认版本后再安装。".to_owned());
    }
    let progress_app = app.clone();
    let mut downloaded = 0_u64;
    let bytes = update
        .download(
            move |chunk_len, total| {
                downloaded = downloaded.saturating_add(chunk_len as u64);
                let _ = progress_app.emit(
                    PROGRESS_EVENT,
                    AppUpdateProgress {
                        downloaded,
                        total,
                        phase: "downloading",
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载或签名校验失败，更新未安装：{error}"))?;

    // Download (including the plugin's signature verification) completes
    // before the process lifecycle or installer slots are claimed.
    let cli = super::tooling::reserve_cli_lifecycle_for_app_update()?;
    let reservation = UpdateReservation::claim(&app)?;
    let receipt = reservation.receipt();
    #[cfg(target_os = "windows")]
    let _helper = tauri::async_runtime::spawn_blocking(
        crate::platform::app_update::stop_user_helper_for_update,
    )
    .await
    .map_err(|_| "结束后台小助手失败，应用更新已取消。".to_owned())??;

    let size = bytes.len() as u64;
    let _ = app.emit(
        PROGRESS_EVENT,
        AppUpdateProgress {
            downloaded: size,
            total: Some(size),
            phase: "installing",
        },
    );

    #[cfg(target_os = "windows")]
    {
        // Windows install() launches NSIS then directly exits the process,
        // bypassing Tauri's exit hooks and Drop. Cleanup must precede install.
        // The updater launch/exit ordering also needs the NSIS update-only
        // bounded parent wait; sleeping before install cannot close that race.
        crate::save_window_state_before_exit(&app);
        crate::cleanup_before_exit(&app).await;
        crate::remove_tray_icon_before_exit(&app);
        update.install(bytes).map_err(|error| {
            format!("安装更新失败：{error}。退出前清理已完成，代理可能已暂停；请重启应用后重试。")
        })?;
        // Normally unreachable: the Windows plugin exits after launching NSIS.
        // Retain every reservation until a fallback backend restart occurs.
        let _keep_alive = (flight, cli, reservation, receipt);
        app.restart();
    }

    #[cfg(target_os = "macos")]
    {
        // Install returns on macOS. Failure leaves proxy/window/tray state
        // intact; RAII releases the Update claim and all installer gates.
        update
            .install(bytes)
            .map_err(|error| format!("安装更新失败，应用仍可继续使用：{error}"))?;
        crate::start_app_update_cleanup(app, receipt, (flight, cli, reservation));
        Ok(())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) async fn install(_app: AppHandle, _version: String) -> Result<(), String> {
    Err("当前平台不支持应用内更新，请打开下载页手动更新。".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{update_endpoints, GITHUB_ENDPOINT};

    #[test]
    fn update_endpoints_without_mirror_use_only_github() {
        for mirror in [None, Some(""), Some("   ")] {
            assert_eq!(update_endpoints(mirror)[0].as_str(), GITHUB_ENDPOINT);
            assert_eq!(update_endpoints(mirror).len(), 1);
        }
    }

    #[test]
    fn update_endpoints_accept_https_mirror_before_github() {
        // A second path on the existing GitHub host is only a test fixture.
        let endpoints = update_endpoints(Some(
            " https://github.com/fy-agent/fyagent/releases/download/test/latest.json ",
        ));
        assert_eq!(
            endpoints[0].as_str(),
            "https://github.com/fy-agent/fyagent/releases/download/test/latest.json"
        );
        assert_eq!(endpoints[1].as_str(), GITHUB_ENDPOINT);
    }

    #[test]
    fn update_endpoints_ignore_non_https_or_invalid_mirrors() {
        for mirror in [
            "http://github.com/fy-agent/fyagent/releases/download/test/latest.json",
            "file:///latest.json",
            "not a URL",
            "https://",
            "https://user:password@github.com/fy-agent/fyagent/releases/download/test/latest.json",
            "https://github.com/fy-agent/fyagent/releases/download/test/latest.json#fragment",
        ] {
            let endpoints = update_endpoints(Some(mirror));
            assert_eq!(endpoints.len(), 1);
            assert_eq!(endpoints[0].as_str(), GITHUB_ENDPOINT);
        }
    }

    #[test]
    fn update_endpoints_deduplicate_github() {
        assert_eq!(update_endpoints(Some(GITHUB_ENDPOINT)).len(), 1);
    }
}
