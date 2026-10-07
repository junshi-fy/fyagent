# 应用内更新维护说明

## 当前边界

后端通过 `check_app_update` 和 `install_app_update` 提供检查与用户确认后的安装；渲染层没有 updater 插件权限或前端插件包。独立更新面板与顶部红点已实现，面板接入「关于」由后续改动完成。发布流水线本次未修改，线上尚不能据此认定更新可用。

## 签名和发版

`src-tauri/tauri.conf.json` 当前的 `plugins.updater.pubkey` 是**测试公钥**。上线前必须换成正式公钥，并离线备份配套私钥。私钥不得提交到仓库；丢失私钥会使使用旧公钥的客户端无法接收后续更新。

下一项流水线工作需要通过秘密配置注入 `TAURI_SIGNING_PRIVATE_KEY`，生成安装包对应的 `.sig` 和 updater 格式的 `latest.json`，扩充发布附件合同并验证下载后的实际字节。Windows Authenticode 签名应先完成，再生成 Tauri 更新签名；若在更新签名之后修改安装包，原 `.sig` 会失效。macOS 更新包也必须覆盖最终签署、公证和后台 helper 的实际产物。

## 下载地址

配置文件只包含 GitHub：`https://github.com/fy-agent/fyagent/releases/latest/download/latest.json`。

国内镜像地址确定后，在**编译 Rust 后端时**通过环境变量 `FYAGENT_UPDATE_MIRROR_ENDPOINT` 注入完整 HTTPS 更新清单 URL。没有配置、空值、非 HTTPS 或非法 URL 均忽略；合法配置生成 `[国内镜像, GitHub]`，重复地址去重。运行时通过 `app.updater_builder().endpoints(...)` 使用该列表。修改环境变量后需重新构建，不是运行时设置。

Tauri 仅在前一个 endpoint 请求或解析报错时才尝试下一个；镜像成功返回旧清单时，GitHub 新版本会被挡住。因此镜像清单和安装包必须同步，同步失败应视为发版失败，不能先发布新版本再忽略镜像失败。此处不预设国内域名。

## 生命周期与验收

下载和签名校验完成后才占用既有进程生命周期；安装任务仍在运行时拒绝更新。Windows 插件安装会直接退出进程，必须先停止固定安装路径的后台小助手，再保存窗口状态、撤回 Live 接管、停止代理和移除托盘。macOS 安装成功后走共享清理与重启入口；不支持的平台拒绝安装且不下载、不占用生命周期。

Windows 小助手先接收既有取消事件并有最多 5 秒正常收尾时间，仍未退出时只终止可执行路径严格匹配固定安装路径的进程。保留同一个进程句柄并再次核对路径，避免 PID 重用扩大目标。无法确认路径、发现其他安装目录的同名进程、停止失败或 helper 处于隔离状态时，取消更新并保留应用运行。

生命周期使用独立的 Update 转换和仅允许更新拥有者调用的释放方法。安装失败会释放生命周期与 Agent/CLI/helper 门禁。Windows 已执行退出前清理后若安装器启动失败，代理和托盘不会自动恢复，错误提示要求用户重启；生命周期锁损坏时恢复失败会记录日志，也需重启。

插件先启动 NSIS 再退出主程序，Rust 无法在退出后继续协调；NSIS 仅 `/UPDATE` 等待主程序结束，最多 `20 × 250ms`，超时仍拒绝安装，不终止主程序。正式验收仍需观察 UAC、helper 正常收尾、NSIS EarlyChecks 和安装后重启。

当前只有代码审阅及 mock/unit 证据。上线还需 Rust 编译、分叉 CI，以及 Windows/macOS 真机签名下载、UAC、helper 停止、NSIS 检查、失败恢复、安装与重启证据。

参考：[Tauri 官方更新插件说明](https://v2.tauri.app/plugin/updater/)。
