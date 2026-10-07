# 应用内更新交付与验收

实现已冻结，验收尚未全部关闭。证据级别：`code_audit` + mock/unit。没有 Rust 编译、`runtime_screenshot`、`pixel_diff` 或真实签名安装证据；不声称生产更新已可用。

## 65c157d0 复核修正（2026-10-08）

本轮仅修正默认更新产物开关、计时合同、维护说明和相关记录。默认 `createUpdaterArtifacts: false`，更新产物与 `.sig` 由具备签名私钥的发版流水线生成；保留 updater 公钥、endpoints 和 Windows passive 配置。计时常量断言锁定 `8_000` / `86_400_000`，时间推进全部使用独立字面量。

交付：[默认构建配置](../../../src-tauri/tauri.conf.json)、[配置合同](../../../tests/appUpdateContract.test.ts)、[计时合同](../../../tests/renderer/features/app-update.test.tsx)、[维护说明](../../../docs/fyagent/app-update-maintenance.md)、[状态规范](../../spec/frontend/state-management.md)、[Rust 注释](../../../src-tauri/src/services/app_update.rs)、[结构资产哈希](../../../scripts/tasks/supported-platform-structure-assets.json)。

源码核实（`code_audit`）：插件 2.12.0 的网络错误、HTTP 非 2xx、`RemoteRelease` 反序列化失败会尝试下一地址；204 直接返回没有更新，`res.json().await?` 读取/解析 JSON 失败直接返回错误；缺少当前平台条目和成功的旧清单都不会回退。维护说明已写明镜像须先同步并校验，检查请求超时 300 秒，下载的 `Update.timeout` 为 `None`，下载只占 `InstallFlight`。Rust 行为未改。

根因与预防：默认构建打开更新产物但发版流水线尚无私钥，会造成打包失败；将默认关闭写入配置合同与规范，要求发版流水线在最终字节上用 `tauri signer sign` 生成 `.sig`（不在 `tauri build` 时打开该开关）。三语用户手册本轮未改（构建开关属于开发细节，不写进用户手册）。计时测试此前用生产常量推算期望，现用独立数字防止调度周期变化漏检。

本轮验收命令均先加载已配置环境脚本 `$FYAGENT_ENV_FILE`，关闭 stdin，顺序运行：

```sh
source "$FYAGENT_ENV_FILE"
timeout 600 pnpm test:unit tests/appUpdateContract.test.ts tests/renderer/features/app-update.test.tsx tests/renderer/features/app-update-panel.test.tsx tests/renderer/platform/appUpdate.test.ts tests/renderer/widgets/app-shell/TopBar.test.tsx tests/desktopSecurityBoundary.test.ts tests/repositoryWorkstationPathContract.test.ts </dev/null
timeout 300 node scripts/tasks/supported-platform-check.mjs </dev/null
timeout 300 pnpm exec prettier --check --ignore-unknown <本轮修改文件> </dev/null
timeout 30 git diff --check </dev/null
```

| 检查                | 实际结果                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 指定 7 文件单测     | Codex 沙箱内：31 项通过、1 失败（路径合同扫描 `spawnSync git EPERM`）；沙箱外复跑：7 文件 32 项全过，另含 releaseWorkflow 等共 12 文件 199 项全过 |
| 平台扫描            | Codex 沙箱内 `spawnSync git EPERM`；沙箱外复跑通过（3125 current files）                                                                          |
| 独立 Git 子进程复现 | 确认 `spawnSync git EPERM`；不修改测试或扫描器绕过沙箱                                                                                            |
| 结构资产 SHA-256    | 仅同步已登记的 app_update.rs 原始字节哈希；tauri.conf.json 未登记                                                                                 |
| Prettier            | 退出 0；12 个支持格式的文件通过；Rust 无 parser，以 --ignore-unknown 跳过，仅改注释                                                               |
| git diff --check    | 退出 0；0 whitespace 错误                                                                                                                         |

路径合同和规定平台扫描仍需沙箱外复跑，不声明整体验收通过。

## 文件及修改原因

| 文件                                                                                                                                                                                                | 修改原因                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`                                                                                                                                                      | 增加官方 `tauri-plugin-updater = "2"`；用户已用 `cargo metadata` 更新锁文件，新增 `tauri-plugin-updater 2.12.0` 等依赖 |
| `src-tauri/tauri.conf.json`                                                                                                                                                                         | 默认关闭更新产物；签名私钥可用时由发版流水线生成产物和 .sig；保留测试公钥、GitHub endpoint、Windows passive            |
| `src-tauri/permissions/app-update.toml`（新增）、`capabilities/default.json`                                                                                                                        | 精确授权两个应用命令，没有 updater 插件权限                                                                            |
| `src-tauri/src/commands/settings.rs`、`commands/agent_catalog.rs`                                                                                                                                   | 薄命令和登记总数 398                                                                                                   |
| `src-tauri/src/lib.rs`                                                                                                                                                                              | 桌面插件非致命注册、命令注册、更新生命周期释放、保留门禁直到共享清理实际重启                                           |
| `src-tauri/src/services/app_update.rs`（新增）、`services/mod.rs`                                                                                                                                   | endpoint 纯函数、元数据、进度事件、签名下载、互斥安装、生命周期接入及测试                                              |
| `src-tauri/src/platform/app_update.rs`（新增）、`platform/mod.rs`                                                                                                                                   | Windows 固定 helper 路径判断、限时等待、句柄绑定终止及纯函数测试                                                       |
| `src-tauri/src/codex_desktop/platform/windows/helper.rs`、`windows/mod.rs`                                                                                                                          | 复用既有取消事件与 helper gate，保留隔离拒绝语义                                                                       |
| `src-tauri/src/codex_desktop/jobs.rs`、`services/codex_desktop/mod.rs`                                                                                                                              | 增加 Update 状态及只能释放 Update 拥有者的方法与测试                                                                   |
| `src-tauri/src/agent_install/jobs.rs`、`services/tooling.rs`                                                                                                                                        | 下载后原子占用 Agent/CLI 安装门禁，失败释放，关闭新安装竞态                                                            |
| `src-tauri/nsis/installer.nsi`                                                                                                                                                                      | 仅 UPDATE 模式等待主程序退出，20 次 × 250ms；正常安装仍立即检查                                                        |
| `scripts/release/verify-windows-nsis-contract.mjs`、`tests/windowsNsisContract.test.ts`                                                                                                             | 验证重试只属于 UPDATE 且次数/延迟/初始化不可被放宽                                                                     |
| `src/shared/features/app-update/types.ts`（新增）                                                                                                                                                   | 窄平台端口和返回/进度数据类型                                                                                          |
| `src/shared/features/app-update/useAppUpdateController.ts`（新增）                                                                                                                                  | 启动 8 秒和 24 小时节流、精确版本跳过、手动安装、订阅释放                                                              |
| `src/shared/features/app-update/provider.tsx`（新增）                                                                                                                                               | 独立应用更新状态                                                                                                       |
| `src/shared/features/app-update/AppUpdatePanel.tsx`、`app-update-panel.css`（新增）                                                                                                                 | 中文面板、进度、错误与现有 open_external 下载退路，复用既有视觉 token                                                  |
| `src/shared/platform/tauri/feature-ports/appUpdate.ts`（新增）                                                                                                                                      | 仅应用命令与窄事件，严格解码，复用已有验证函数                                                                         |
| `src/shared/features/ports.ts`、`src/shared/platform/browser/features.ts`、`tauri/features.ts`                                                                                                      | 接线 FeaturePorts；浏览器明确不可安装                                                                                  |
| `src/widgets/app-shell/AppShell.tsx`、`TopBar.tsx`、`top-bar-actions.css`                                                                                                                           | 根 Provider、关于按钮红点与无障碍文字                                                                                  |
| `tests/renderer/features/app-update.test.tsx`（新增）、`app-update-panel.test.tsx`（新增）、`tests/renderer/platform/appUpdate.test.ts`（新增）、`tests/renderer/widgets/app-shell/TopBar.test.tsx` | hook 8 项、面板 5 项、端口 4 项、TopBar 共 3 项                                                                        |
| `tests/appUpdateContract.test.ts`（新增）                                                                                                                                                           | 配置与自定义权限合同 2 项                                                                                              |
| `tests/desktopSecurityBoundary.test.ts`、`tests/renderer/platform/tauriAclContract.test.ts`                                                                                                         | 禁止 updater:\*；窄应用命令及 renderer 143 命令合同                                                                    |
| `tests/msw/handlers.ts`                                                                                                                                                                             | 两个更新命令 mock，不触发真实安装                                                                                      |
| `scripts/tasks/supported-platform-check.mjs`、`tests/remainingPlatformSurface.test.ts`                                                                                                              | 精确整块登记其他平台零副作用拒绝 stub；旧负例自动检查放宽后必须失败                                                    |
| `scripts/tasks/supported-platform-structure-assets.json`                                                                                                                                            | 同步修改源文件指纹及新平台敏感模块                                                                                     |
| `docs/user-manual/zh/installation.md`、`en/installation.md`、`ja/installation.md`                                                                                                                   | 三语更新说明；明确关于面板和正式发版还待接入                                                                           |
| `docs/fyagent/app-update-maintenance.md`（新增）                                                                                                                                                    | 测试密钥替换、镜像、签名顺序、流水线下一步、生命周期风险                                                               |
| `.trellis/spec/frontend/state-management.md`                                                                                                                                                        | 移除已失效的“更新器仍未恢复”规范，记录独立 Provider 与窄端口                                                           |
| `.trellis/tasks/10-08-one-click-update/`（新增）                                                                                                                                                    | PRD、设计、闭环清单、任务状态、本证据                                                                                  |

初次实现未修改 AboutDialog、about-dialog.css、Cargo.lock、package.json、pnpm-lock.yaml、CHANGELOG、.github。用户随后用 `cargo metadata` 更新 Cargo.lock；本轮只修复文档路径和红点圆角，并更新验收记录。上游只以 v3.20.4 的 git show 读取。代理没有运行 cargo/rustup/mise，没有启动真实更新或终止任何系统进程。

## 生命周期与 Windows helper

1. 预检查正在运行的 Codex Desktop、Agent 和 CLI 安装任务；下载期间不占进程生命周期，不预下载。
2. 用户确认版本后重新检查同一版本；官方插件下载并验证签名，失败不进入清理。
3. 下载完成才原子占用 CLI writer、Agent gate 与既有生命周期的 Update 状态；期间拒绝新安装和其他退出/重启的清理所有权。
4. Windows 先发既有 helper 取消事件，最多 5 秒正常等待。只对可执行路径等于 fixed_user_helper_path 的同一进程句柄执行后备终止，2 秒确认退出，再重新枚举并占 helper gate。其他目录同名进程、未知路径、隔离或停止失败均拒绝更新，尚未做退出清理。
5. Windows 在插件 install 前保存窗口、撤回 Live 接管、停止代理、移除托盘。官方插件启动 NSIS 后直接退出父进程，Rust 无法在退出后继续握手，因此 NSIS 仅 UPDATE 模式有限重试主程序检查；仍不能退出就 Abort。
6. macOS install 返回成功后保留所有门禁进入既有共享清理和重启 worker；安装失败保持原运行状态。
7. RAII 释放失败安装的 Update 状态和门禁，不能释放 Exit/Restart 状态。Windows 清理后若安装器启动失败，代理/托盘不会自动恢复，错误明确要求重启；锁损坏会记录恢复失败日志，也需重启。

仍需 Windows/macOS 真机验证 UAC、签名、helper 正常取消与后备终止、NSIS EarlyChecks/Install、安装器启动失败、权限拒绝、最终重启。NSIS 的 5 秒等待边界需真机确认。

## 地址及发版配置

`option_env!("FYAGENT_UPDATE_MIRROR_ENDPOINT")` 读取构建时值。空/非法/非 HTTPS 忽略；合法值生成 `[镜像, GitHub]`，去重，再传 updater_builder.endpoints。未指定就是配置中的唯一 GitHub。没有预设任何镜像域名。

插件 2.12.0 在网络错误、HTTP 非 2xx 或 RemoteRelease 反序列化失败时尝试下一地址；204 直接返回没有更新，响应 JSON 读取/解析失败直接返回错误；可解析清单缺少当前平台条目时不回退。成功但旧的镜像清单会挡住 GitHub，发版必须先同步镜像并校验，失败视为发版失败。默认 createUpdaterArtifacts 为 false；运行时检查不依赖该开关。流水线本次未改；正式上线须替换测试公钥并离线备份私钥，仓库 secret TAURI_SIGNING_PRIVATE_KEY 映射为 tauri signer sign 实际读取的 TAURI_PRIVATE_KEY / TAURI_PRIVATE_KEY_PASSWORD，在最终字节上签名：Windows 为 Authenticode 签名后的 setup.exe，macOS 为 staple 后 FyAgent.app 打成的 .app.tar.gz（根目录 FyAgent.app/，不是 DMG）；再生成 latest.json，不在 tauri build 时打开 createUpdaterArtifacts。Windows Authenticode 在 Tauri 更新签名之前完成，否则改写产物会使 .sig 失效。

## 新增 Rust 测试（未执行）

- `update_endpoints_without_mirror_use_only_github`
- `update_endpoints_accept_https_mirror_before_github`
- `update_endpoints_ignore_non_https_or_invalid_mirrors`
- `update_endpoints_deduplicate_github`
- `helper_shutdown_admits_only_the_fixed_executable_path`
- `failed_update_releases_its_claim_and_unblocks_installers`
- `update_abort_cannot_release_an_exit_or_restart_owner`
- `update_claim_rejects_active_desktop_installs`
- `app_update_reservation_blocks_new_jobs_and_releases_on_failure`
- `app_update_reservation_admits_terminal_jobs_without_changing_their_result`

## 路径与设计 token 修复验证（历史记录，2026-10-08）

以下沙箱外结果由用户实际运行并提供；完整单测结果属于本轮修复前的运行，不代表修复后全部通过。

| 检查                                              | 实际结果                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `node scripts/tasks/supported-platform-check.mjs` | 通过，3125 current files                                                  |
| `pnpm run typecheck`                              | 通过                                                                      |
| `pnpm run lint`                                   | 通过                                                                      |
| `pnpm run format:check`                           | 通过                                                                      |
| `git diff --check`                                | 通过                                                                      |
| 完整 `pnpm test:unit`                             | 217 个文件中 8 个失败，29 项失败；本轮处理下述两处合同失败                |
| Cargo.lock                                        | 用户已用 `cargo metadata` 更新，新增 `tauri-plugin-updater 2.12.0` 等依赖 |
| Rust 编译、clippy、`cargo test`                   | 尚未运行，待分叉 CI；`verification` 为 `pending_ci`                       |

完整单测的两处改动问题为 `repositoryWorkstationPathContract` 的具体工作站路径和 `designTokens` 的红点圆角字面量。本轮将路径改为语义占位，红点改为现有 `--fy-radius-circle`；任务目录其他文件、维护说明和更新面板 CSS 未发现同类问题。

其余失败按用户提供的结果归因：`miseTaskContract` 21 项由 `mise.toml` 未 trust 导致；`developmentEnvironment`、`taskDocs`、`systemCheck`、`windowsMsvcCross`（2 项）属于本机环境原因；`repositoryGovernanceScan` 在未改动的 `main` 上同样失败，属于已有基线问题。本轮不修复这些失败，不放宽测试。

本轮定向复验结果：4 个文件中 3 个通过、1 个失败；12 项中 11 项通过、1 项失败。`designTokens`、`TopBar`、`app-update-panel` 全部通过；`repositoryWorkstationPathContract` 的语义占位用例通过，仓库扫描用例因无法枚举 Git 文件失败。独立 `spawnSync("git")` 检查确认 `EPERM`，须由用户在沙箱外复跑该用例，不声称路径合同已通过。

任务目录和维护说明的工作站路径扫描无匹配（`code_audit`）。本轮 3 个修改文件的 Prettier 检查通过；`git diff --check` 通过。

复验命令（`$FYAGENT_ENV_FILE` 表示已配置的环境脚本）：

```sh
source "$FYAGENT_ENV_FILE" && timeout 600 pnpm test:unit tests/renderer/shared/designTokens.test.ts tests/repositoryWorkstationPathContract.test.ts tests/renderer/widgets/app-shell/TopBar.test.tsx tests/renderer/features/app-update-panel.test.tsx </dev/null
timeout 300 pnpm exec prettier --check .trellis/tasks/10-08-one-click-update/acceptance.md .trellis/tasks/10-08-one-click-update/task.json src/widgets/app-shell/top-bar-actions.css </dev/null
timeout 10 git diff --check </dev/null
```

## 上一轮沙箱检查（历史记录）

以下 pnpm/node 命令均先执行 `source "$FYAGENT_ENV_FILE"`（已配置的环境脚本），stdin 为 `/dev/null`，测试进程串行运行。`$RUSTFMT_BIN` 表示指定工具链中的 rustfmt 可执行文件。

| 命令                                                                                                                                                              | 实际结果                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `timeout 900 pnpm run typecheck </dev/null`                                                                                                                       | 退出 0，0 类型错误                                                                               |
| `timeout 900 pnpm run lint </dev/null`                                                                                                                            | 退出 0，0 lint 错误/警告                                                                         |
| `timeout 900 pnpm exec prettier --check <24 个修改/新增前端、测试、脚本文件> </dev/null`                                                                          | 24 个文件通过，0 失败                                                                            |
| `timeout 60 "$RUSTFMT_BIN" --edition 2021 --config skip_children=true --check <13 个修改/新增 Rust 文件> </dev/null`                                              | 13 个文件通过，0 失败；直接执行 rustfmt，不调用 rustup                                           |
| 下方完整 `pnpm test:unit` 命令                                                                                                                                    | 23 个文件：17 通过、6 失败；278 项：263 通过、15 失败；另 1 个 suite 加载失败已计入 6 个失败文件 |
| 最后 Rust cfg 修正后，下方 6 文件 `pnpm test:unit` 复验                                                                                                           | 6 文件、22 项通过，0 失败                                                                        |
| `timeout 300 node scripts/release/verify-windows-nsis-contract.mjs </dev/null`                                                                                    | 退出 0，4 个 NSIS 区段合同通过                                                                   |
| `timeout 300 node scripts/tasks/supported-platform-check.mjs </dev/null`                                                                                          | 退出 1，`spawnSync git EPERM`，规定 CLI 未通过                                                   |
| 原扫描器导出的 `inspectRepository` + shell 捕获的实际 git ls-files/stage                                                                                          | 3125 文件、0 findings（区别于规定 CLI）                                                          |
| `timeout 300 node node_modules/dependency-cruiser/bin/dependency-cruise.mjs --config config/dependency-cruiser.cjs --output-type err-long src scripts </dev/null` | 465 模块、1373 依赖、0 违反分层/循环                                                             |
| Python 直接核对 invoke_handler/permissions                                                                                                                        | 398 注册 = 398 权限，重复 0、缺失 0、多余 0                                                      |
| `git diff --check`                                                                                                                                                | 退出 0，0 whitespace 错误                                                                        |

上一轮定向测试命令：

```sh
source "$FYAGENT_ENV_FILE" && timeout 900 pnpm test:unit tests/appUpdateContract.test.ts tests/renderer/features/app-update.test.tsx tests/renderer/features/app-update-panel.test.tsx tests/renderer/platform/appUpdate.test.ts tests/desktopSecurityBoundary.test.ts tests/renderer/platform/tauriAclContract.test.ts tests/architecture tests/releaseWorkflow.test.ts tests/windowsNsisContract.test.ts tests/remainingPlatformSurface.test.ts tests/renderer/widgets/app-shell tests/renderer/app/router-shell.test.tsx tests/renderer/app/architecture.test.ts tests/renderer/app/route-render-isolation.test.tsx tests/msw/nativeFetchTauriMock.test.ts tests/desktop-acceptance --maxWorkers=1 --no-file-parallelism </dev/null
```

最后变更仅为非支持平台 Update variant 和重启判定的 cfg，指纹随后同步。该变更的复验命令：

```sh
source "$FYAGENT_ENV_FILE" && timeout 900 pnpm test:unit tests/appUpdateContract.test.ts tests/desktopSecurityBoundary.test.ts tests/renderer/platform/tauriAclContract.test.ts tests/architecture/nativeSecurityOrdering.test.ts tests/architecture/rustModuleBoundaries.test.ts tests/architecture/frontendModuleBoundaries.test.ts --maxWorkers=1 --no-file-parallelism </dev/null
```

失败分布：releaseWorkflow 6、remainingPlatformSurface 4、dependencyGraph 2、rootGovernance 2、desktopAcceptanceContract 1；rendererConsolidation 在导入时 spawnSync git EPERM。desktopAcceptance 的空 stderr 是子进程错误的次生断言失败。独立对 git/bash/node 的 spawnSync 均复现 EPERM，未修改断言或扫描器子进程逻辑。完整输出保存为临时日志 `fyagent-update-final-unit.log`。

替代平台扫描未放宽 production scanner：实际文件和 stage 由 shell Git 只读捕获，新文件只登记到临时 index 副本用于 mode 校验，不修改真实 index；原 scanner 全部源码、cfg、指纹、静态与栅格规则继续执行。该历史证据不能替代规定的 CLI 成功；用户后续沙箱外运行的通过结果见「路径与设计 token 修复验证」。

开发过程中已修复的失败：配置/权限初始合同 2 项失败作为先验复现；mock Promise 类型错误 1 个和 lint unused 参数 3 个已修复；核心平台扫描暴露的两个 not(windows) 隐式目标边界已改成显式 Windows/macOS 和精确零副作用拒绝 stub。当前验证状态以「65c157d0 复核修正」为准。

Cargo.lock 已由用户更新；Rust 类型/借用/Send、Windows/macOS cfg、官方插件编译集成、10 个 Rust 测试和 clippy -D warnings 仍待分叉 CI 验证。

## 接入关于页需要的改动

本次没有修改 `src/widgets/app-shell/AboutDialog.tsx` 或 `about-dialog.css`。

以当前文件行号为准：AboutDialog.tsx 第 3 行附近新增 import，删除第 58–60 行的「查看更新」ExternalLinkButton，在第 64 行 links 容器后、details 前插入面板。帮助/反馈等并行改动由关于页负责人合并。Provider 已在 AppShell 根部，无需重复挂载。

```tsx
import { AppUpdatePanel } from "../../shared/features/app-update/AppUpdatePanel";

// 删除原「查看更新」ExternalLinkButton，保留链接区中的其他入口。
<AppUpdatePanel />;
```

## 上一轮 git diff --stat（历史记录）

上一轮未暂存 diff 的统计为 **34 files changed, 577 insertions(+), 45 deletions(-)**，不是当前已暂存工作树的统计。
另有 **19 个新增文件**（未暂存，不进入 git diff --stat）：更新模块、权限、测试、维护说明和本任务目录。未执行 git add/commit/push。文件清单见上表。

```text
 .trellis/spec/frontend/state-management.md         |  7 +-
 docs/user-manual/en/installation.md                | 12 +++-
 docs/user-manual/ja/installation.md                | 12 +++-
 docs/user-manual/zh/installation.md                | 12 +++-
 scripts/release/verify-windows-nsis-contract.mjs   | 15 +++-
 scripts/tasks/supported-platform-check.mjs         |  8 +++
 .../tasks/supported-platform-structure-assets.json | 36 +++++++---
 src-tauri/Cargo.toml                               |  1 +
 src-tauri/capabilities/default.json                |  3 +-
 src-tauri/nsis/installer.nsi                       | 11 +++
 src-tauri/src/agent_install/jobs.rs                | 83 ++++++++++++++++++++++
 src-tauri/src/codex_desktop/jobs.rs                | 83 ++++++++++++++++++++++
 .../src/codex_desktop/platform/windows/helper.rs   | 40 +++++++++--
 .../src/codex_desktop/platform/windows/mod.rs      |  3 +-
 src-tauri/src/commands/agent_catalog.rs            |  4 +-
 src-tauri/src/commands/settings.rs                 | 14 ++++
 src-tauri/src/lib.rs                               | 81 ++++++++++++++++++++-
 src-tauri/src/platform/mod.rs                      |  1 +
 src-tauri/src/services/codex_desktop/mod.rs        |  5 ++
 src-tauri/src/services/mod.rs                      |  1 +
 src-tauri/src/services/tooling.rs                  | 10 +++
 src-tauri/tauri.conf.json                          |  9 ++-
 src/shared/features/ports.ts                       |  1 +
 src/shared/platform/browser/features.ts            |  5 ++
 src/shared/platform/tauri/features.ts              |  2 +
 src/widgets/app-shell/AppShell.tsx                 | 37 +++++-----
 src/widgets/app-shell/TopBar.tsx                   |  7 +-
 src/widgets/app-shell/top-bar-actions.css          | 11 +++
 tests/desktopSecurityBoundary.test.ts              |  6 ++
 tests/msw/handlers.ts                              |  7 ++
 tests/remainingPlatformSurface.test.ts             |  4 +-
 tests/renderer/platform/tauriAclContract.test.ts   |  4 +-
 tests/renderer/widgets/app-shell/TopBar.test.tsx   | 58 ++++++++++++++-
 tests/windowsNsisContract.test.ts                  | 29 ++++++++
 34 files changed, 577 insertions(+), 45 deletions(-)
```
