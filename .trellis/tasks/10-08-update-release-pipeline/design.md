# 设计

沿用源 SHA 冻结、Windows 独立 seal、精确附件集合与草稿事务。新增 formal 更新签名 job，读取封好的 Windows EXE 和 macOS 构建上传的最终 app 压缩包。macOS 压缩包与更新签名输出均通过不可变 artifact ID 传递。

私钥值只在更新签名 step 注入 CLI 的 TAURI_PRIVATE_KEY / TAURI_PRIVATE_KEY_PASSWORD。eligibility 只读取 secret 存在性的布尔表达式；preflight 跳过这些检测步骤。禁用全部新增依赖缓存。

纯函数模块生成并验证 version、notes、pub_date、四平台 signature / HTTPS URL，以及 base64 minisign key ID。独立验签采用 Node 内置 Ed25519 与 BLAKE2b，核对最终文件及可信注释。四平台普通键由插件 2.12.0 get_urls 的后缀优先、普通键回退规则支持。

formal 更新的 3 个 sig、macOS tar.gz 和 GitHub latest.json 全部进入原 attestation，形成 11→12；镜像清单根据同一组已证明的签名生成，仅替换 URL，公开回读校验清单字段和实际文件 SHA-256。

镜像先同步并通过回读，才允许 GitHub 草稿事务。BASE_URL 空时跳过镜像并写 summary；非空时凭据缺失、上传或回读失败均 fail-closed。GitHub 发布后的公开回读失败无法自动撤销已发布版本，应报告失败并人工独立核验。
