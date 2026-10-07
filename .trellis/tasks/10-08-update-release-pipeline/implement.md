# 执行清单

- [x] 编写纯清单、key ID、最终字节验签及公开回读模块和定向测试。
- [x] 加入正式配置预检、最终 app 打包、更新签名 job，扩充 formal 证明合同。
- [x] 加入镜像上传与回读门禁，发布后 GitHub 回读，冻结镜像地址并注入正式构建。
- [x] 更新发布测试、维护文档和发布规范（三语用户手册不写流水线细节，不改）。
- [x] 加签名干跑测试：一次性密钥走一遍签名、验签和清单门禁。
- [x] 顺序运行 actionlint、指定单测、平台检查、Prettier、git diff --check；同步登记哈希。实际结果见 acceptance.md，未把受阻项目记为通过。
- [x] 记录真实验收结果和正式发版待实测边界。

## 验证命令

先加载任务提供的环境文件。全部命令使用 timeout 和关闭标准输入；未并发运行测试。

```sh
timeout 120 ~/.local/bin/actionlint .github/workflows/release.yml </dev/null
timeout 900 pnpm test:unit tests/releaseWorkflow.test.ts tests/releaseAssets.test.ts tests/releaseCheckAggregation.test.ts tests/devReleaseEligibility.test.ts tests/devReleaseRemote.test.ts tests/releaseDraftOwnership.test.ts tests/changelogReleaseContract.test.ts tests/appUpdateContract.test.ts tests/updaterManifest.test.ts tests/updaterSigningDryRun.test.ts </dev/null
timeout 300 node scripts/tasks/supported-platform-check.mjs </dev/null
timeout 600 pnpm typecheck </dev/null
timeout 600 pnpm lint </dev/null
timeout 300 pnpm exec prettier --check <本任务修改的全部文件> </dev/null
timeout 30 git diff --check </dev/null
```
