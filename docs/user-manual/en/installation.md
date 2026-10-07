# Installation and updates

Download the package for your platform from [fy-agent/fyagent Releases](https://github.com/fy-agent/fyagent/releases). Check that release's signing notes, SHA-256, source SHA and attestation.

| Platform | Requirements                             | Package                                                                          |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Windows  | Windows 10 or later, x64 / ARM64         | `FyAgent-X.Y.Z-Windows-x64-setup.exe` or `FyAgent-X.Y.Z-Windows-arm64-setup.exe` |
| macOS    | macOS 12 or later, Intel / Apple Silicon | `FyAgent-X.Y.Z-macOS.dmg`                                                        |

On Windows, run the machine-wide installer and finish the wizard. If a trust prompt appears, verify the download source and signing status of that build, and follow your organization's security policy.

On macOS, open the DMG, drag `FyAgent.app` into Applications, and launch it there. If macOS blocks it, verify the download and release evidence, then follow System Settings → Privacy & Security → Open Anyway. Keep Gatekeeper and download quarantine protection enabled.

On first launch, choose a purpose for recommendations or select 「跳过引导」 (Skip guide). Follow [AI software configuration](agents.md) to scan and install software. MCP installation identifies required runtimes such as Node.js / npx or uv / uvx; prepare those before proceeding.

## In-app updates

Once the update panel is connected, open About (「关于」) and select Check for updates (「检查更新」). FyAgent also checks after startup. A new version only adds a small red dot to the About button; it does not open a popup. Skip this version (「跳过这个版本」) hides its dot, while a later version will still be indicated. A manual check still shows a skipped version, so you can install it or undo the skip.

Update now (「立即更新」) downloads the update, verifies its signature, then installs it and restarts FyAgent. Wait for any software installation task to finish before updating. On Windows, FyAgent stops its background helper before installation, and each update displays a “Do you want to allow this app to make changes?” prompt.

The update panel is not yet connected to About, and signed update releases and the update manifest are not yet published. For now, download a matching package from the same Releases page and follow its instructions. When checking fails, Open download page (「打开下载页」) will also provide this manual fallback.

## Uninstalling

Use Windows Settings → Apps or move the macOS application to Trash. Personal data defaults to `~/.fyagent/`; back up anything you want to keep before changing those files.

[Back to manual](README.md)
