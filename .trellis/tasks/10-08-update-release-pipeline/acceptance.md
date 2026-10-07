# 验收证据

状态：实现完成，沙箱外本地验收通过；正式启用待正式密钥、国内镜像配置和第一次 formal。证据等级：code_audit + unit/mock；未运行正式签名、上传或发布，不声明生产验收通过。

## 交付物

- [发布工作流](../../../.github/workflows/release.yml)：正式预检、最终 app 压缩、独立签名、镜像门禁、GitHub 公开回读。
- [附件合同](../../../scripts/release/release-contract.mjs)、[收集器](../../../scripts/release/collect-workflow-artifacts.mjs)、[集合校验](../../../scripts/release/verify-release-files.mjs)、[草稿附件事务](../../../scripts/release/prepare-release-publication.mjs)：formal 11→12，preflight 6→7，精确集合及下载字节比较。
- [纯清单模块](../../../scripts/release/updater-manifest.mjs)、[验签与回读](../../../scripts/release/updater-release.mjs)、[S3 上传](../../../scripts/release/sync-updater-mirror.mjs)：含对应 .d.mts。
- [新增测试](../../../tests/updaterManifest.test.ts)、[工作流测试](../../../tests/releaseWorkflow.test.ts)、[附件测试](../../../tests/releaseAssets.test.ts)：缺平台、签名 / key ID / 版本 / URL 漂移、非 HTTPS、缓存旧版、损坏文件、网络失败、上传顺序及门禁；仓库里只有明显无效的零填充假公钥 / 假签名。
- [签名干跑测试](../../../tests/updaterSigningDryRun.test.ts)：没有正式私钥时，用锁定版本的 Tauri CLI 在系统临时目录生成一次性密钥，按流水线同样的 `TAURI_PRIVATE_KEY` / `TAURI_PRIVATE_KEY_PASSWORD` 签三个假安装包，再用发版脚本验签、改一个字节必须验签失败、生成并校验 latest.json、缺一个签名必须失败；测试结束删除临时目录，密钥不进仓库。
- [维护说明](../../../docs/fyagent/app-update-maintenance.md)、[发布规范](../../spec/backend/github-release-workflow.md)：配置、失败顺序和真实启用边界。三语用户手册不写流水线细节，本任务未改。

## 2026-10-08 实际检查结果

第一轮在 Codex 沙箱内跑，git / Node / Bash 子进程报 EPERM，12 项测试和平台扫描无法完成。下表是沙箱外复跑的结果（Node 24.19.0）。

| 检查                                                           | 实际结果                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 指定 10 个测试文件（含 updaterManifest、updaterSigningDryRun） | 10 个文件、262 项全部通过                                                                                                        |
| actionlint 1.7.12 + shellcheck 0.11.0                          | 4 个诊断，全是既有的 Windows ARM runner 标签 `windows-11-vs2026-arm` 不被工具认识；改动前的工作流同样 4 个；新增 job 和脚本 0 个 |
| supported-platform-check                                       | 通过                                                                                                                             |
| typecheck / lint                                               | 通过                                                                                                                             |
| Prettier / git diff --check                                    | 通过                                                                                                                             |
| 结构登记                                                       | 只同步 tests/releaseWorkflow.test.ts 的原始字节 SHA-256；未修改扫描器、清单路径或检查规则                                        |
| 上游更新配置检查                                               | 分支改动里没有 CC Switch 的更新公钥、下载站地址、发版地址和上游三个更新文件                                                      |

一次复跑发现原有 macOS 签名校验调用次数断言仍是 3；本次增加原 app 和解压 app 校验后应为 5，已同步并复跑。

## Job 依赖

eligibility → Windows / macOS 构建 → pin-release-build-inputs；Windows formal transform → fresh seal。sign-updates-formal 直接依赖 eligibility、build-macos、pin-release-build-inputs、seal-windows-formal。verify-assets 同时接收构建 / pin、互斥的 Windows proof 或 seal、formal signer 成功（preflight 要求 skipped）→ attest。配置镜像时 attest → sync-update-mirror（上传后公开回读）→ publish；无镜像时 sync-update-mirror 必须 skipped。publish 仍直接要求 eligibility / attest 成功，并在事务发布后执行 GitHub 公开回读。

## 配置与实测边界

唯一公开仓库变量为 `FYAGENT_UPDATE_MIRROR_BASE_URL`。Tauri 签名 secrets 为 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。镜像 secrets 为 `FYAGENT_UPDATE_MIRROR_S3_ENDPOINT`、`FYAGENT_UPDATE_MIRROR_S3_BUCKET`、`FYAGENT_UPDATE_MIRROR_S3_PREFIX`（可空）、`FYAGENT_UPDATE_MIRROR_ACCESS_KEY_ID`、`FYAGENT_UPDATE_MIRROR_SECRET_ACCESS_KEY`。其余既有 Windows / Apple 配置不变。

仍保留测试公钥，故正式发版会 fail-closed；必须由运营配置正式密钥，不在本任务生成密钥。锁定 CLI 与 Node 独立验签的互通已由签名干跑测试（一次性密钥）证实；正式密钥的实际签名、tar 票据 / helper 保留、真实 S3 服务和 CDN、GitHub 11 个 attestation subjects / 12 个附件、公开回读及各架构更新安装只能在第一次正式发版实测。当前环境没有 aws CLI。

实现采用 CLI 实际接受的 TAURI_PRIVATE_KEY 环境变量映射要求的 secret 名；Windows 普通平台键由插件 2.12.0 源码证实支持 NSIS。保留既有 Windows Authenticode signed / unsigned 政策，Tauri 更新签名对 formal 始终强制。eligibility 只得到 secret 存在性的布尔值，实际私钥 / S3 凭据仅进入各自需要它们的 job step。跨系统不能原子发布：镜像先更新成功后若 GitHub 失败，镜像用户可能已收到新版；公开发布后回读失败会标红，但不自动删除或撤销公开版本。
