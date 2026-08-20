# #68 Windows Authenticode 细计划

写于 2026-08-20 20:40 上海时间。junshi-fy 落盘。不关票。不推 `fy-agent/fyagent` 主仓。

拍板：Azure Trusted Signing（方案 B）。不上 Microsoft Store，不先买 OV/PFX，不先走 SignPath。

#117 已合（0.4.1 macOS 公证）。0.4.1 的 Windows 包按设计仍是未签名，**不补签、不移动 `v0.4.1`**。签名从下一正式 annotated tag 开始。

---

## 仓库里已经有的（不要重做）

发版工作流已经把 Windows 拆成互斥两路：

- 预检：`prove-windows-preflight`，无密钥，证明严格 `NotSigned`
- 正式：`sign-windows-formal`（唯一带密钥的 provider job）→ 只上传不信任的 `formal-candidate-*`
- 密封：`seal-windows-formal` 换一台同架构干净 runner，再验一遍 raw `NotSigned`，只承认「字节完全相同的未签名输出」或「只改了 Authenticode 的 PE」

脚本已经在：

- `scripts/release/windows-signing.mjs`：`asset` / `transform` / `verify-sealed` / `aggregate`
- 合同：`.trellis/spec/backend/windows-installer.md`、`github-release-workflow.md`

开关已经在：

- `FYAGENT_WINDOWS_SIGNING_MODE` = `unsigned` | `provider`
- `FYAGENT_WINDOWS_SIGN_EXPECTED_PUBLISHER`
- `FYAGENT_WINDOWS_SIGN_EXPECTED_CERTIFICATE_SHA256`
- `FYAGENT_WINDOWS_SIGNER_ADAPTER`（绝对路径，必须是 `.ps1`）
- `FYAGENT_WINDOWS_SIGNER_CREDENTIAL`（只传给 adapter，仓库代码不读、不序列化）

当前正式发布仍是 `unsigned`。#68 不是新开流水线，是把 provider 这条路接上 Azure，再把仓库变量打到 `provider`。

NongHua123 在 #68 的 2026-08-12 评论已经锁了门禁：`signtool verify /pa /all /v /tw`，只接受退出码 0，warning（2）当失败。Trusted Signing 证书大约三天有效，时间戳是过期后还能验的关键。

---

## 和邻票怎么切

| 票 | 谁先 | 做什么 |
| --- | --- | --- |
| #67 | 先 | 发行身份的 owner、备份、审批、到期、轮换、泄露怎么停发。Azure 账号和 GitHub Environments 写进这张，不写进 #68 |
| #68 | #67 身份表填完 | 接 adapter、x64/arm64 分别签、分别验、干净机 SmartScreen |
| #70 | #68 能产出 Valid 证据 | 把 Windows 签名结果绑进 Release Manifest / 关于页 |
| #35 / #55 / #41 | 并行不插队 | 签名实现不抢这条清零。计划可以先写 |
| #117 / v0.4.1 | 已合，不回头 | Windows 未签名是故意的。下一正式 tag 再签 |

---

## 以后怎么做（刀序）

### 刀 0 · #67 身份（没有这个不准改 mode）

1. Azure 里开 Trusted Signing 账户。owner / 维护人 / 审批人 / 恢复联系人 / 到期日写进 #67，不要只活在某台电脑。
2. GitHub Environment 只给正式 tag 的 `sign-windows-formal`。fork PR、普通 CI、日志、build artifact 读不到。
3. 期望 Publisher 和证书 SHA-256 来自受控配置，不能从待签文件反学。
4. 做一次纸面轮换/泄露演练：停发、吊销、受影响版本、用户通知、恢复发版。

没有刀 0，禁止把 `FYAGENT_WINDOWS_SIGNING_MODE` 改成 `provider`。

### 刀 1 · adapter（只碰签名边界）

1. 写一个临时 `.ps1` adapter，给 `windows-signing.mjs transform` 用。它只收候选安装包绝对路径和 `x64|arm64`。
2. 里面调 Azure Trusted Signing（SignTool / 官方集成），**必须** RFC 3161 时间戳。仓库不把 Azure 语法写成长期合同。
3. adapter 只许改 PE 校验和与 security directory。改别的，`seal-windows-formal` 必须拒。
4. 密钥只用已有的 `FYAGENT_WINDOWS_SIGNER_CREDENTIAL`，只在 `sign-windows-formal` 里出现。
5. x64 用 `windows-2025`，arm64 用 `windows-11-arm`。两台分别签，证据不能互相代替。
6. 测：`tests/windowsSigningAdapter.test.ts` 已有 unsigned / provider 矩阵，接着跑，不另起测试框架。

### 刀 2 · 打开 provider，不改 0.4.1

1. 仓库变量改成 `provider`，填期望 Publisher 和证书 SHA-256。缺一项就硬失败，不准退回 unsigned 假装成功。
2. 只对下一正式 annotated tag 生效。`workflow_dispatch` 预检继续 unsigned。
3. `verify-sealed` 在干净 runner 上独立探签名。`aggregate` 要求 x64/arm64 模式一致，都是 Valid。
4. 发布门禁：`signtool verify /pa /all /v /tw /o <目标系统>` 只要退出码 0。缺签、Publisher 不符、无时间戳、链失败、只 warning，正式发布失败关闭。
5. 对安装器里的主程序、helper、卸载器逐个复验。漏一个就失败。

### 刀 3 · 干净 Windows 验收（#68 四条）

在没装过 FyAgent 的 Windows 上，x64、arm64 各记一份：

- SmartScreen / UAC
- 安装、首次启动、升级、卸载
- 证据字段：`assetSha256, arch, publisherSubject, signerCertSha256, timestampAuthority, timestampTime, chainStatus, targetOS`

没这四份记录，不把 #68 标完成。军师不代关票。

---

## 明确不做

- 不新开 “Support Windows Authenticode signing” 票
- 不上 Microsoft Store / 不改 NSIS 去 MSIX（#68 要的是现有 setup.exe）
- 不把 `.pfx` 塞进仓库或长期 Actions secret 当主方案
- 不自己养 HSM
- 不在 build job 里签名
- 不补签、不移动 `v0.4.1`
- 不推主仓，不在 fork PR 里放证书

---

## 什么时候动手

- **计划**：现在写完，评论到 #68，文档放 `junshi-fy/fyagent`
- **代码**：刀 0 完成，并且 0.4.1 公证现场有人过过之后
- **目标包**：下一正式 Windows 包（0.4.2 或再下一个 annotated tag），不是 0.4.1
- **不插进** #35 / #55 / #41 清零

---

## 怎么算做完

对着 #68 四条验收，加上：

- `sign-windows-formal` 是唯一碰密钥的 job
- `seal-windows-formal` 在另一台同架构机器上独立承认签名
- x64、arm64 证据分开，模式一致
- #67 身份表能指到 Azure 账户和轮换窗口
- #70 还没绑 provenance 之前，#68 可以先产出 Valid 证据，但不关 #70
