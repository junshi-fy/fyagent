# 设计

后端 transport -> app_update service -> 官方 updater / 既有生命周期 / Windows 系统调用层。下载结束再 claim；Windows 安装前清理，macOS 安装后复用重启清理。helper 仅允许终止固定安装路径的进程。

前端 FeaturePorts 增加窄更新端口；独立 Provider 保存检查/下载/跳过状态；面板复用共享 UI，TopBar 消费红点。浏览器端明确不可用。

视觉沿用 FyAgent 控制台：既有字体和主题 token、共享 Button、状态色红点，不新建视觉体系。
