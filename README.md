# PI-gui（Pi Desktop 中文增强版）

<p align="left">
  <a href="https://github.com/akirnsdsd/PI-gui/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/akirnsdsd/PI-gui/ci.yml?branch=main&style=flat-square" /></a>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-6b7280?style=flat-square" /></a>
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square" />
</p>

<p align="left">
  <img src="./assets/branding/pi-desktop-icon.svg" alt="Pi Desktop 图标" width="112" />
</p>

PI-gui 是面向 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 的桌面客户端。它以
`pi --mode rpc` 为运行时，在 Tauri 原生窗口中提供中文界面、多项目与多会话管理、终端、
文件浏览、模型渠道、扩展包、Skills 和 MCP 管理等能力。

本项目基于开源项目
[gustavonline/pi-desktop](https://github.com/gustavonline/pi-desktop)
继续开发，保留原项目的 MIT 许可证与来源说明。

> 当前处于持续开发阶段，尚未发布本仓库的稳定安装包。请先按下文从源码运行或构建。

## 功能概览

- 完整中文界面，覆盖聊天、侧边栏、设置、扩展、模型渠道、变更审查等主要区域
- 多工作区、多项目、多会话管理，支持置顶、重命名、历史浏览与从消息分叉
- 流式对话时间线，展示工具调用、思考过程、运行状态和上下文统计
- 内置终端、项目文件树、文件预览、拖拽附件与本地文件引用
- Git 分支切换、远程分支拉取，以及暂存/未暂存变更审查
- 模型渠道管理：预设、自定义 Base URL、模型拉取、默认模型和渠道复制
- macOS 钥匙串保存 API Key，并对明文旧配置提供迁移能力
- 扩展包、散放扩展、Skills、MCP 服务器和项目资源信任管理
- 渠道地址安全校验、重定向限制、SSRF 防护与配置事务回滚
- 主题、桌面通知、命令面板、快捷键和桌面更新检查

更完整的能力清单见 [`FEATURE_MAPPING.md`](./FEATURE_MAPPING.md)，架构说明见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 技术栈

- 桌面框架：[Tauri 2](https://tauri.app/)
- 前端：TypeScript、Lit、Vite
- 原生后端：Rust
- 终端：xterm.js
- Agent 运行时：Pi CLI RPC

> 前端使用 Lit，不是 React。

## 环境要求

- Node.js 22 或更高版本
- npm
- Rust stable 工具链
- Tauri 2 对应平台的系统依赖
- Pi Coding Agent CLI

安装 Pi CLI：

```bash
npm install -g @mariozechner/pi-coding-agent
```

各平台 Tauri 依赖请参考
[Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)。

## 本地开发

```bash
git clone https://github.com/akirnsdsd/PI-gui.git
cd PI-gui
npm install
npm run tauri dev
```

如果应用没有自动找到 `pi`，可在“设置 → 更新 → CLI”中指定 `pi` 可执行文件的绝对路径。

## 检查与测试

```bash
npm run check
npm run test:channels
npm run build:frontend
cargo test --manifest-path src-tauri/Cargo.toml
```

项目还包含独立的 TypeScript 自检文件，可按文件头部注释中的命令运行。

## 打包桌面应用

```bash
npm install
npm run check
npm run build
```

构建产物位于：

```text
src-tauri/target/release/bundle/
```

常见产物：

- macOS：`.app`、`.dmg`
- Windows：`.msi`、NSIS `.exe`
- Linux：`.AppImage`、`.deb`

当前构建默认未配置代码签名。macOS 若被 Gatekeeper 拦截，可在确认安装包来源可信后执行：

```bash
xattr -cr "/Applications/Pi Desktop.app"
```

也可以在“系统设置 → 隐私与安全性”中选择“仍要打开”。

## GitHub 自动构建

仓库已包含以下工作流：

- `ci.yml`：TypeScript 检查、前端构建和 Rust 检查
- `release.yml`：推送 `v*` 标签后构建 macOS、Windows、Linux 安装包并发布 Release
- `release-smoke.yml`：对已有 Release 的安装包做平台烟雾测试

发布版本前请先阅读 [`docs/RELEASES.md`](./docs/RELEASES.md)。

## 项目结构

```text
.
├── src/                       # Lit/TypeScript 前端
│   ├── channels/              # 模型渠道配置与安全校验
│   ├── components/            # UI 组件
│   ├── extensions/            # 扩展桥接与兼容层
│   ├── i18n/zh/               # 中文文案
│   └── rpc/                   # Pi RPC 桥接
├── src-tauri/                 # Rust/Tauri 原生后端
├── assets/                    # 品牌与内置资源
├── docs/                      # 架构、权限、发布与扩展文档
└── .github/workflows/         # CI 与跨平台发布流程
```

## 安全与隐私

- 不要提交 `.env`、`.mcp.json`、API Key、访问令牌或本机绝对路径。
- 本仓库已忽略本地 `.mcp.json`；需要共享配置时请创建去敏后的示例文件。
- 应用需要文件系统与进程权限来运行本地 Agent，请在受限环境部署前审查
  [`src-tauri/capabilities/default.json`](./src-tauri/capabilities/default.json)。
- 安全漏洞请通过
  [GitHub 私密安全报告](https://github.com/akirnsdsd/PI-gui/security/advisories/new)
  提交，不要公开创建 Issue。

更多说明见 [`SECURITY.md`](./SECURITY.md) 和
[`docs/PERMISSIONS.md`](./docs/PERMISSIONS.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读：

- [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

建议在提交前运行 TypeScript 检查、前端构建和 Rust 测试，并为 UI 变更附上截图。

## 开源许可

本项目采用 [MIT License](./LICENSE)。

项目基于 Pi Desktop 开发；原项目及后续贡献者的版权声明与许可证均予以保留。
