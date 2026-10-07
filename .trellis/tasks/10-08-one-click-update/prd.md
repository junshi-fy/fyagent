# FyAgent 应用内更新

恢复官方 Tauri 更新插件，只通过 `check_app_update` / `install_app_update` 暴露给渲染层。使用用户指定测试公钥和 GitHub endpoint，可构建期注入 HTTPS 镜像。

验收：生命周期互斥、Windows helper 路径限定停止、下载签名校验、克制自动检查和版本跳过、独立更新面板、TopBar 红点、三语手册及维护说明。关于页接入与发布流水线留给后续任务。

约束：禁止 cargo/rustup/mise；禁止修改 Cargo.lock、package.json、pnpm-lock.yaml、CHANGELOG.md、.github、AboutDialog.tsx、about-dialog.css；上游目录只读。
