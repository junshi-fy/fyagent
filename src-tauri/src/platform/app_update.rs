//! Identity-bound shutdown of the fixed Windows user helper before an update.

#[cfg(any(target_os = "windows", test))]
fn helper_image_matches_fixed_path(image: &str, fixed: &str) -> bool {
    fn normalized(path: &str) -> String {
        let path = path.strip_prefix(r"\\?\").unwrap_or(path);
        path.replace('/', "\\").to_ascii_lowercase()
    }
    !image.is_empty() && !fixed.is_empty() && normalized(image) == normalized(fixed)
}

#[cfg(target_os = "windows")]
pub(crate) fn stop_user_helper_for_update() -> Result<impl Send, String> {
    use crate::codex_desktop::platform::windows::{
        cancel_helpers_for_app_update, reserve_helper_for_app_update,
    };

    let fixed = crate::platform::process_launch::fixed_user_helper_path()
        .map_err(|_| "无法确认后台小助手的安装路径，应用更新已取消。".to_owned())?;
    cancel_helpers_for_app_update()?;
    windows::stop_matching_helpers(&fixed)?;
    // Closing active helpers must also let their protocol owner settle. A
    // quarantined admission still refuses this reservation instead of dropping
    // its pinned package/image. Keep this lease alive through update.install().
    let lease = reserve_helper_for_app_update()?;
    windows::stop_matching_helpers(&fixed)?;
    Ok(lease)
}

#[cfg(target_os = "windows")]
mod windows {
    use std::{
        ffi::OsString,
        mem::size_of,
        os::windows::ffi::OsStringExt,
        path::Path,
        time::{Duration, Instant},
    };

    use ::windows::{
        core::PWSTR,
        Win32::{
            Foundation::{
                CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE,
                WAIT_OBJECT_0, WAIT_TIMEOUT,
            },
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                Threading::{
                    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
                    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                    PROCESS_TERMINATE,
                },
            },
        },
    };

    struct OwnedProcess(HANDLE);

    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn stopped_error() -> String {
        "后台小助手未能安全结束，应用更新已取消；请结束当前任务或重启应用后重试。".to_owned()
    }

    fn image_path(process: HANDLE) -> Result<String, String> {
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .map_err(|_| stopped_error())?;
        if length == 0 || length as usize > buffer.len() {
            return Err(stopped_error());
        }
        OsString::from_wide(&buffer[..length as usize])
            .into_string()
            .map_err(|_| stopped_error())
    }

    fn matching_helpers(fixed: &Path) -> Result<Vec<OwnedProcess>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|_| stopped_error())?;
        let snapshot = OwnedProcess(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
            return if unsafe { GetLastError() } == ERROR_NO_MORE_FILES {
                Ok(Vec::new())
            } else {
                Err(stopped_error())
            };
        }
        let fixed = fixed.to_str().ok_or_else(stopped_error)?;
        let mut matches = Vec::new();
        loop {
            let length = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = OsString::from_wide(&entry.szExeFile[..length]);
            if name
                .to_string_lossy()
                .eq_ignore_ascii_case("fyagent-user-helper.exe")
            {
                let handle = match unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                        false,
                        entry.th32ProcessID,
                    )
                } {
                    Ok(handle) => Some(OwnedProcess(handle)),
                    Err(_) if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER => None,
                    Err(_) => return Err(stopped_error()),
                };
                if let Some(handle) = handle {
                    if unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0 {
                        if !super::helper_image_matches_fixed_path(&image_path(handle.0)?, fixed) {
                            // NSIS also rejects helpers from another installation.
                            // Never terminate such a process by its filename.
                            return Err("发现其他安装目录的后台小助手仍在运行，请先正常结束它，再更新应用。".to_owned());
                        }
                        matches.push(handle);
                    }
                }
            }
            entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                return if unsafe { GetLastError() } == ERROR_NO_MORE_FILES {
                    Ok(matches)
                } else {
                    Err(stopped_error())
                };
            }
        }
    }

    pub(super) fn stop_matching_helpers(fixed: &Path) -> Result<(), String> {
        let helpers = matching_helpers(fixed)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        for helper in helpers {
            // The same opened process object is retained for wait, image
            // revalidation and termination. PID reuse cannot widen the target.
            let remaining = deadline.saturating_duration_since(Instant::now());
            match unsafe {
                WaitForSingleObject(helper.0, remaining.as_millis().min(u32::MAX as u128) as u32)
            } {
                WAIT_OBJECT_0 => continue,
                WAIT_TIMEOUT => {}
                _ => return Err(stopped_error()),
            }
            if !super::helper_image_matches_fixed_path(
                &image_path(helper.0)?,
                fixed.to_str().ok_or_else(stopped_error)?,
            ) {
                return Err(stopped_error());
            }
            unsafe { TerminateProcess(helper.0, 1) }.map_err(|_| stopped_error())?;
            if unsafe { WaitForSingleObject(helper.0, 2_000) } != WAIT_OBJECT_0 {
                return Err(stopped_error());
            }
        }
        if !matching_helpers(fixed)?.is_empty() {
            return Err(stopped_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::helper_image_matches_fixed_path;

    #[test]
    fn helper_shutdown_admits_only_the_fixed_executable_path() {
        let fixed = r"C:\Program Files\FyAgent\fyagent-user-helper.exe";
        assert!(helper_image_matches_fixed_path(fixed, fixed));
        assert!(helper_image_matches_fixed_path(
            "c:/program files/FYAGENT/fyagent-user-helper.exe",
            fixed,
        ));
        assert!(helper_image_matches_fixed_path(
            r"\\?\C:\Program Files\FyAgent\fyagent-user-helper.exe",
            fixed,
        ));
        for candidate in [
            r"C:\other\fyagent-user-helper.exe",
            r"C:\Program Files\FyAgent\fyagent.exe",
            r"C:\Program Files\FyAgent\fyagent-user-helper.exe.bak",
            r"C:\Program Files\FyAgent\..\FyAgent\fyagent-user-helper.exe",
            "fyagent-user-helper.exe",
            "",
        ] {
            assert!(!helper_image_matches_fixed_path(candidate, fixed));
        }
        assert!(!helper_image_matches_fixed_path("", ""));
    }
}
