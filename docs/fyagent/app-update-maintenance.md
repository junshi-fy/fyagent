# 应用内更新维护说明

## 当前边界

后端通过 `check_app_update` 和 `install_app_update` 提供检查与用户确认后的安装；渲染层没有 updater 插件权限或前端插件包。独立更新面板与顶部红点已实现，面板接入「关于」由后续改动完成。正式发版流程已准备更新签名、清单和镜像校验；正式启用仍须换正式公钥、配置正式私钥并完成第一次正式发版，不能据此认定线上更新已可用。

## 签名和发版

`src-tauri/tauri.conf.json` 当前的 `plugins.updater.pubkey` 是**测试公钥**。上线前必须换成正式公钥，并离线备份配套私钥。私钥不得提交到仓库；丢失私钥会使使用旧公钥的客户端无法接收后续更新。

默认构建保持 `bundle.createUpdaterArtifacts: false`，避免只有公钥、没有私钥时打包失败；运行时检查更新不依赖此开关。更新产物和 `.sig` 由发版流水线在签名私钥可用时生成。

formal 的 `eligibility` 提前拒绝缺失的签名 secret 和测试公钥（key ID `B24D446F5B80F951`），仅接收 secret 是否存在的布尔值，不接收私钥内容。私钥值只注入独立的 `sign-updates-formal` job 的签名 step，不写入文件、不缓存、不输出日志。仓库 secret 名为 `TAURI_SIGNING_PRIVATE_KEY`（口令 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`），但仓库锁定 CLI（2.8.x）的 `pnpm tauri signer sign` 子命令读取的是 `TAURI_PRIVATE_KEY`（或 `TAURI_PRIVATE_KEY_PATH`）和口令 `TAURI_PRIVATE_KEY_PASSWORD`，流水线在签名 step 里把两个 secret 映射到这两个变量再调用；`TAURI_SIGNING_PRIVATE_KEY*` 只被打包期的 `createUpdaterArtifacts` 签名读取，而本仓库不打开它（之后的嵌 helper、Authenticode 签名、Developer ID 签名和公证都会改动字节，提前生成的 `.sig` 会对不上）。

签名在最终字节上进行：Windows 使用 `seal-windows-formal` 独立封好的最终 x64 / ARM64 setup.exe；macOS 在 Developer ID 签署、helper 嵌入、app 公证、staple 和最终校验全部完成后，将完整 `FyAgent.app` 打包为 `FyAgent-X.Y.Z-macOS-universal.app.tar.gz`。macOS 签名对象不是 DMG（更新器不安装 DMG）。tar 保持单一顶层 app，归档根目录必须是 `FyAgent.app/`（插件 2.12.0 解压时丢掉第一层路径，与 CLI 自带打包布局一致），禁用 AppleDouble 元数据生成以适配插件的 Rust tar 解压；压缩包解压后再次核对 app 内容、签名和公证票据，任何丢失都直接失败。更新签名之后不能再改包。现有 Windows Authenticode signed / unsigned 政策保持不变；Tauri 更新签名对 formal 始终必需，两者用途不同。已公开的同版本 Release 在 eligibility 阶段被拒绝，避免正式重试先覆写其镜像。

签名后解码 base64 包裹的 minisign 公钥与 `.sig`，比较二进制包中小端 key ID，并用 Node 内置 Ed25519 / BLAKE2b 校验最终文件和可信注释。无私钥的 `verify-assets` 聚合 job 再次验签。更新产物经不可变 artifact ID 传递，3 个 `.sig`、macOS `.app.tar.gz`、GitHub `latest.json` 全部进入既有 GitHub attestation：formal 从 6 个证明对象 / 7 个附件扩为 11 个证明对象 / 12 个附件。preflight 仍是原来的 6→7，不接触更新私钥、不生成更新产物、不运行镜像同步。

CLI 2.8.x 的 `.sig` 可信注释只有 `timestamp` 和 `file`，不含版本号；插件的 `requireSignedVersion` 默认关闭，当前配置也没开。仍用这一版 CLI 签名时不要打开该开关，否则更新会被拒绝。

`latest.json` 是 Tauri v2 静态清单，包含本次 `version`、英文版本说明 `notes`、eligibility 冻结的 UTC `pub_date`，以及 `windows-x86_64`、`windows-aarch64`、`darwin-aarch64`、`darwin-x86_64` 四项。Windows URL 是最终 NSIS EXE，两个 macOS 平台共用 universal 压缩包；signature 保留 `.sig` 文件内容。插件 2.12.0 的 `get_urls` 先查带安装器后缀的键，再回退普通平台键；下载器按 EXE 识别 NSIS，因此这里使用普通键。GitHub URL 固定为 `https://github.com/fy-agent/fyagent/releases/download/vX.Y.Z/<文件名>`。

## 必须配置的变量和 secret

| 类型     | 名称                                      | 用途                                                  |
| -------- | ----------------------------------------- | ----------------------------------------------------- |
| secret   | `TAURI_SIGNING_PRIVATE_KEY`               | 与正式公钥对应的更新签名私钥，只以环境变量进入 signer |
| secret   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`      | 正式私钥口令；本流程要求非空，使用加密私钥            |
| 仓库变量 | `FYAGENT_UPDATE_MIRROR_BASE_URL`          | 本次文件的公开 HTTPS 根地址；不配置则仅使用 GitHub    |
| secret   | `FYAGENT_UPDATE_MIRROR_S3_ENDPOINT`       | S3 兼容上传接口的 HTTPS 地址                          |
| secret   | `FYAGENT_UPDATE_MIRROR_S3_BUCKET`         | 上传 bucket                                           |
| secret   | `FYAGENT_UPDATE_MIRROR_S3_PREFIX`         | 对象前缀，可空；须与公开 BASE_URL 的路径映射一致      |
| secret   | `FYAGENT_UPDATE_MIRROR_ACCESS_KEY_ID`     | 上传访问 ID                                           |
| secret   | `FYAGENT_UPDATE_MIRROR_SECRET_ACCESS_KEY` | 上传访问密钥                                          |

BASE_URL 非空时，除允许为空的 PREFIX 外，上述镜像 secret 任一缺失都在 eligibility 失败。凭据实际值只进入 `sync-update-mirror` 的上传 step，映射 AWS 环境变量；使用 runner 自带 `aws s3 cp --endpoint-url`，不增加第三方 Action、不保存认证文件。存储服务必须允许匿名 HTTPS 下载，且 S3 bucket / prefix 映射到 BASE_URL；此处不指定厂商或域名。已有 Apple Developer ID / 公证与 Windows 签名提供方配置沿用既有发布规范。

## 上线前待办

以下几项未完成前，合入本流水线后的 formal 发版会在 eligibility 阶段直接失败（fail-closed），preflight 不受影响：

1. 正式更新私钥：由谁生成、在哪台机器生成、离线备份放在哪里、谁能取用，待 William 决定。本仓库和流水线不生成正式密钥。
2. 测试公钥替换：拿到正式密钥后，把 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 换成正式公钥（当前测试公钥 key ID `B24D446F5B80F951` 会被 formal 拒绝），并把私钥和口令配置为仓库 secret `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
3. 国内下载站：选定存储服务和公开地址，配置仓库变量 `FYAGENT_UPDATE_MIRROR_BASE_URL` 和上表的镜像 secret；不配置时只走 GitHub，job summary 会写「未配置镜像」。
4. 第一次正式发版时按下文「生命周期与验收」逐项实测。

## 下载地址

配置文件只包含 GitHub：`https://github.com/fy-agent/fyagent/releases/latest/download/latest.json`。

formal 的 eligibility 冻结并校验 `vars.FYAGENT_UPDATE_MIRROR_BASE_URL`，Windows / macOS 的 `tauri build` 将它加 `/latest.json` 作为编译期 `FYAGENT_UPDATE_MIRROR_ENDPOINT`；空值不嵌入地址，镜像 job 跳过，job summary 写「未配置镜像」。非空而非 HTTPS、带凭据、查询或片段的配置直接阻断正式发版。运行时合法配置生成 `[国内镜像, GitHub]` 并去重，通过 `app.updater_builder().endpoints(...)` 使用该列表。修改地址需重新构建，不是运行时设置；preflight 不嵌入镜像地址。

`tauri-plugin-updater 2.12.0` 的 `check()` 在网络错误、HTTP 非 2xx 或 `RemoteRelease` 清单反序列化失败时会尝试下一个地址；HTTP 204 直接返回没有更新。响应 JSON 读取或解析失败（`res.json().await?`）会直接返回错误；清单能解析但没有当前平台条目时也不会尝试下一个地址。镜像成功返回旧清单会挡住 GitHub 新版本，因此发版必须先同步镜像清单和安装包并校验，同步或校验失败应视为发版失败。此处不预设国内域名。

## 镜像与 GitHub 发布顺序及失败处理

顺序是最终封包 → 更新签名 → 精确聚合与 attestation → 镜像同步及公开回读 → GitHub 草稿事务发布 → GitHub 公开回读。镜像先上传三个更新包及各自 `.sig`，全部成功后最后上传镜像版 `latest.json`，其 signature / 版本 / 日期 / 说明与 GitHub 版一致，仅 URL 替换为 BASE_URL 下的文件地址。

回读使用无登录凭据的 curl，强制 HTTPS 和 HTTPS 重定向，添加防缓存参数与 `Cache-Control: no-cache`，单次连接 15 秒、传输 300 秒，最多 4 轮、轮间等待 5 秒。每轮先读取公开 `BASE_URL/latest.json`，核对本次版本、四平台签名和预期 URL，再下载三个实际更新包及 `.sig`，核对 SHA-256 和签名文件内容。上传或校验不符、过期清单、缺平台、HTTP 错误、下载损坏，重试耗尽均使发版失败。发布后对 GitHub `releases/latest/download/latest.json` 和它指向的版本文件执行同样校验；必须与本次版本一致。

镜像先于 GitHub 更新；若镜像回读成功而之后 GitHub 草稿创建、上传、事务校验或发布失败，镜像用户可能已收到新版。这是跨存储系统无法原子提交的取舍。反过来先发布 GitHub 再同步镜像，会在镜像失败且仍返回有效旧清单时，让这些用户一直停在旧版：Tauri 只在前一个地址发生特定错误时回退，旧清单成功响应不会回退。故镜像失败必须阻断 GitHub 发布。

不自动回滚镜像，因为用户可能已安装新版本。应先独立核验已公开的镜像、Release 状态及失败原因；GitHub 仍是本次源 SHA 的自有草稿时，按原草稿归属协议恢复后重试；已经公开的版本保持不可变。GitHub 发布后回读失败会使 job 失败，但不等于发布被撤销，须人工独立核验并决定后续措施。更换 BASE_URL 或退回 GitHub-only 不会修改旧客户端已编译的镜像地址，不能用这种办法绕过旧镜像的运维责任。

## 生命周期与验收

检查更新的请求有 300 秒超时；下载安装包本身没有单独超时（插件 2.12.0 构造 `Update` 时 `timeout` 为 `None`）。下载期间只占 `InstallFlight`，不占生命周期和 Agent/CLI 门禁。

下载和签名校验完成后才占用既有进程生命周期；安装任务仍在运行时拒绝更新。Windows 插件安装会直接退出进程，必须先停止固定安装路径的后台小助手，再保存窗口状态、撤回 Live 接管、停止代理和移除托盘。macOS 安装成功后走共享清理与重启入口；不支持的平台拒绝安装且不下载、不占用生命周期。

Windows 小助手先接收既有取消事件并有最多 5 秒正常收尾时间，仍未退出时只终止可执行路径严格匹配固定安装路径的进程。保留同一个进程句柄并再次核对路径，避免 PID 重用扩大目标。无法确认路径、发现其他安装目录的同名进程、停止失败或 helper 处于隔离状态时，取消更新并保留应用运行。

生命周期使用独立的 Update 转换和仅允许更新拥有者调用的释放方法。安装失败会释放生命周期与 Agent/CLI/helper 门禁。Windows 已执行退出前清理后若安装器启动失败，代理和托盘不会自动恢复，错误提示要求用户重启；生命周期锁损坏时恢复失败会记录日志，也需重启。

插件先启动 NSIS 再退出主程序，Rust 无法在退出后继续协调；NSIS 仅 `/UPDATE` 等待主程序结束，最多 `20 × 250ms`，超时仍拒绝安装，不终止主程序。正式验收仍需观察 UAC、helper 正常收尾、NSIS EarlyChecks 和安装后重启。

当前只有代码审阅及 mock/unit 证据，外加签名干跑测试（`tests/updaterSigningDryRun.test.ts`）：用锁定版本的 Tauri CLI 在系统临时目录生成一次性加密密钥，按流水线同样的 `TAURI_PRIVATE_KEY` / `TAURI_PRIVATE_KEY_PASSWORD` 签名，再走发版脚本的验签、改字节必失败、`latest.json` 生成与校验和缺签名必失败；测试结束即删除，密钥不进仓库。它证明 CLI 产出的 `.sig` 与 Node 独立验签互通，但不代替正式密钥。正式密钥仍未启用，也未据此完成正式发布。第一次 formal 还需实测：锁定 CLI 对正式加密私钥的签名与插件安装互通；Apple 签名、公证、staple、压缩与解压后的票据 / helper 保留；runner 自带 aws CLI 与选定 S3 服务、匿名公开读取及 CDN 缓存收敛；真实 11 个证明对象和 12 个 Release 附件、草稿恢复、镜像及 GitHub 回读；Windows x64 / ARM64 和 macOS 两种架构的真实更新、UAC、helper 停止、NSIS EarlyChecks、失败恢复、安装与重启。Rust 编译和分叉 CI 仍须单独完成。

参考：[Tauri 官方更新插件说明](https://v2.tauri.app/plugin/updater/)。
