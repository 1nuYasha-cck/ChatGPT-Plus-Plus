# 更新日志 / Changelog

## 1.1.0 — 2026-08-06

- 修复重新安装后错误提示“主题服务缺失”的问题：同步更新内置主题引擎 `stage-theme.mjs` 的大小与 SHA-256 完整性记录。
- 新增主题引擎完整性回归测试，逐项校验发布清单与实际运行时文件，避免主题脚本更新后再次遗漏清单刷新。
- 构建 Windows 与 macOS 发布包前自动重新生成主题完整性清单。
- 更新 1.1.0 双平台下载地址、构建产物名称、发布工作流和 SHA-256 校验文件。

### English

- Fixed the false “Theme service missing” status after reinstalling by synchronizing the bundled `stage-theme.mjs` size and SHA-256 integrity record.
- Added a regression test that verifies every bundled theme runtime file against the integrity manifest.
- Regenerates the theme integrity manifest automatically before Windows and macOS packaging.
- Updated v1.1.0 download links, artifact names, release workflow, and checksum publication.

## 1.0.0 — 2026-08-05

- ChatGPT++ 首个公开版本，支持 Windows x64 与 Apple Silicon Mac。
- 支持本地多账号保存、官方登录添加、`auth.json` 导入、事务切换、备份校验和失败回滚。
- 显示实际账号名称或邮箱、FREE/PLUS/PRO 套餐、有效订阅到期时间、更新时间及 5 小时/7 天剩余额度。
- Mac 菜单栏提供紧凑账号与额度面板；Windows 提供悬浮组件和托盘控制。
- 集成 ChatGPT 主题管理、今日 Token 统计、开机启动、置顶和刷新间隔设置。
- 双平台构建强制执行隐私审计，阻止账号、设置、日志、绝对用户路径、Token 和敏感图片元数据进入发布包。
