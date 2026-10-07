# 闭环清单

- [x] 后端插件、配置、命令、ACL 与生命周期/helper 纯函数测试
- [x] 前端端口、Provider、面板、红点与行为测试
- [x] 三语手册、维护说明、命令登记与 mock
- [x] rustfmt、typecheck、Prettier、lint；相关 unit tests 已运行
- [x] 平台指纹更新；扫描核心 3125 文件零问题；git diff --check
- [ ] 规定的 supported-platform-check CLI 和综合测试全部通过：本机 Node 子进程 EPERM 阻塞
- [x] [交付和验收证据](./acceptance.md)：代码证据、Rust/真机限制、关于页接入示例和 diff stat

测试进程串行运行，子任务仅写测试，不自行执行测试。

实现冻结；验收未关闭。不修改测试断言或放宽平台扫描规则来绕过环境问题。

## 65c157d0 复核修正闭环

- [x] 默认关闭 createUpdaterArtifacts；公钥、endpoints 和 installMode 保持不变
- [x] 测试锁定 8_000 / 86_400_000，计时推进使用字面量
- [x] 核对插件 2.12.0 源码，同步 fallback、签名产物与超时边界说明
- [x] 同步登记文件 SHA-256，已运行指定 7 文件单测、平台扫描、Prettier 和 git diff --check，实际结果写入 [验收记录](./acceptance.md)；Git 子进程 EPERM 的检查仍待沙箱外复跑
