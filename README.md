# dsh-plugin-deepseek-web

把 DeepSeek 网页版（`https://chat.deepseek.com`）接入 DSH 桌面端侧边栏的插件。

在 DSH 左侧「工作区」上方注册一个 **DS** 图标，点击后在右侧面板用 **Electron 隔离 `<webview>`** 打开 DeepSeek 网页版——不消耗 API 额度、直接用网页端自己的会话，并**持久化网页登录态**、跟随 DSH 明暗主题。

> 非官方社区插件，与 DeepSeek 官方无关。使用你自己的 DeepSeek 网页版账号，不绕过登录、额度或付费限制。

## 为什么用 `<webview>` 而不是 `<iframe>`

`chat.deepseek.com` 返回 `Content-Security-Policy: frame-ancestors 'none'`，任何宿主里的 `<iframe>` 都会被浏览器直接拒绝（白屏）。DSH 桌面端主窗口开启了 Electron `webviewTag`，并有**两方验证的租约协议**（`about:blank#<lease>` + partition 校验），因此只有以插件挂在桌面端才成立；浏览器里的 Web GUI 没有这套机制，按钮会自动禁用。

## 功能

| 操作 | 行为 |
|---|---|
| 单击「DS」图标（未打开） | 右侧栏以半屏宽度打开 DeepSeek 网页版 |
| 双击（175 ms 内） | 直接全屏打开，不闪半屏 |
| 单击（已打开）/ **Esc** | 以原生收起动画关闭右侧栏（Tab 与网页状态保留） |
| 面板右上角刷新 | 重建内嵌网页；恢复空白/卡死页面 |
| 首次登录后 | 自动保存网页登录态，之后重启 DSH 不掉登录 |
| 主题 | 自动跟随 DSH 深色/浅色 |

- 网页运行在 Electron 隔离 `webview`（`allowpopups` 已开启，支持网页内 OAuth 等新窗口）。
- 关闭右栏时保留标签和网页状态，再次打开回到原页面；点标签上的 × 才真正销毁。

## 双半结构

DSH 插件是「双半」架构：

| 半部 | 源码 | 产物 | 职责 |
|---|---|---|---|
| **Host**（Node 侧） | `src/host.ts` | `lib/index.js` | 合法 Cordis bundle 占位；本插件不注册 Host 路由、不读 Harness 凭证 |
| **Client**（浏览器侧） | `src/client.ts` | `lib/client.js` | 全部 UI、webview 生命周期、登录持久化、主题同步 |

> 注：Host 半部在 DSH 里运行于 Node 侧、**没有 DOM / `<webview>` 访问权限**，因此 webview 的销毁/重载与主题同步（需要 `webview.executeJavaScript`）必须在 Client 半部实现。Host 半部只负责作为 bundle 存在、让 Client 被挂载。

## 目录结构

全部交付物统一放在 **`build/`** 目录（可直接安装的插件包）：

```text
build/
├── package.json          # dsh.engines / dsh.bundle.patch / dsh.client 声明 + 构建脚本
├── manifest.yaml         # 能力清单（信息性；DSH 实际加载不看它，见文件头说明）
├── cordis.patch.yml      # bundle 插入 profile
├── tsconfig.json         # tsc 编译（CJS）
├── icon.svg              # 插件图标
├── src/
│   ├── host.ts           # Host 半部（生命周期占位）
│   ├── client.ts         # Client 半部（图标、右栏面板、webview、登录、主题）
│   └── dsh.d.ts          # DSH 运行时类型声明（只覆盖用到的表面）
├── scripts/
│   ├── check.mjs         # 静态校验（bundle id / patch / 产物形态）
│   └── finalize.mjs      # lib/host.js -> lib/index.js
└── lib/                  # 构建产物（index.js / client.js）
```

## 登录态持久化（重要说明）

**你最初设想的 `partition="persist:deepseek-session"` 在 DSH 桌面端不可用**，原因：

- DSH 桌面端给插件分配的 webview partition 由私有桥 `window.dshDesktop.browser.acquire(lease)` 按租约协议返回，是**进程级的随机内存分区**（如 `dsh-sidebar-browser-*`），且 `about:blank#<lease>` + partition 要**双向校验**——你无法自己覆盖成 `persist:`，否则租约验证失败、guest 无法启动。官方侧栏浏览器同样如此（sbbbx 仓库已实测并记录该限制）。
- 因此本插件用**保存/恢复登录 token** 的方式实现持久化：DeepSeek 网页把登录信息放在版本化 wrapper `userToken` / `__appKit_userInfo` 中，插件读取其逻辑值保存到 DSH 渲染进程的 `localStorage`（键 `dsh.deepseek-web.auth.v1`），下次启动时在同一源预热页（`/robots.txt`）写回，聊天应用启动前即可恢复登录态，不会先闪登录界面。

本实现已让「重启不掉登录」达成，且比强制 `persist:` 更贴合 DSH 的实际能力边界。

## 安装（DSH Desktop）

DSH Desktop 需自带右侧栏与 Electron `webview` 支持（实测 `0.2.1-rc.3` / Windows）。

### 方式 A：插件管理（推荐）

1. 打开 DSH Desktop → 设置 → 插件。
2. 选择「从本地目录安装」/ 等价入口，选择 **`build/` 目录**（含 `package.json` 的那一层）。
3. 完全退出并重新启动 DSH Desktop。

### 方式 B：DSH CLI

```powershell
cd D:\deepseek_workspace\doubao code\dsh-plugin-deepseek-web\build
dsh plugin --profile desktop add "link:$PWD"
```

> 若 `dsh` 不在 PATH（桌面版可能用自带 CLI），可改用方式 A 或方式 C。

### 方式 C：手动链接（DSH_HOME 默认 `%USERPROFILE%\.dsh`）

```powershell
$target = "D:\deepseek_workspace\doubao code\dsh-plugin-deepseek-web\build"
$link   = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-plugin-deepseek-web"
New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
```

然后把 `@local/dsh-plugin-deepseek-web` 加入该 profile 的 `dsh.profile.bundles`，并在依赖里加
`"@local/dsh-plugin-deepseek-web": "link:D:/deepseek_workspace/doubao code/dsh-plugin-deepseek-web/build"`。
保留 profile 原有条目，不要覆盖整个文件；改完**完全退出并重启** DSH。

> 所有交付物已统一放在 `build/` 目录：`build/` 就是可直接安装的插件包（含 `package.json` 的那一层）。
> 源码 `src/`、编译产物 `lib/`、配置与脚本都在其中，`pnpm install/build/test` 请在 `build/` 内执行。

## 构建与测试

```bash
pnpm install     # 安装 typescript / @types/node
pnpm build       # tsc 编译 -> lib/index.js + lib/client.js
pnpm typecheck   # tsc --noEmit（零 TS 错误）
pnpm check       # 静态校验（bundle id / patch / 产物形态）
pnpm test        # typecheck + check
```

> 改完代码必须重新 `pnpm build`；Client bundle 按 rev 发 URL，同版本号会读到旧产物，记得抬 `package.json` 的 `version` 再重装。

## 已知限制 / DSH API 笔记（开发中发现的问题）

1. **`persist:` partition 不可用**（见上）。登录持久化靠 token 保存/恢复。
2. **Client 必须是单文件纯脚本**：不能有顶层 `import`/`export`，`react` 等由加载器注入的 `require` 提供，不打包；否则浏览器加载器 serve 不到。本项目用 tsc 产 CJS 纯脚本（`node --check` 已校验）。
3. **Host 半部无 DOM 权限**：webview 生命周期与主题同步只能在 Client 半部做；Host 只做占位。你的原设想里「Host 管理 webview」在 DSH 架构下不成立。
4. **依赖私有接口**：`window.dshDesktop.browser`（acquire/release）、`sidebarRightTabs.register`、`sidebar.right.pane.tab` 槽位、`[data-sidebar-right-toggle]` 都是桌面端内部实现；DSH 大版本升级后建议回归。
5. **主题同步依赖 DeepSeek 的 `data-ds-dark-theme` 属性**；DeepSeek 改版后可能需要调整。
6. **登录恢复依赖 DeepSeek 当前的 `userToken` / `__appKit_userInfo` 结构**；官方改版后可能需重新登录一次。
7. **仅桌面版**：浏览器 Web GUI 无 `dshDesktop.browser`，按钮自动禁用。
8. 每次启动 DeepSeek 可能弹「使用环境异常」提示，插件已在预热页写入其 `closeUnsafeEnvWarn` 关闭偏好（等同点击提示 ×），不修改 User-Agent、不改变隔离。

## 安全边界

- 无 Host HTTP 路由；不读取 Harness API Key 或账号凭证。
- 网页登录 token 只存本机 DSH 渲染进程 `localStorage`。
- Guest 运行在 Electron sandbox：无 Node、无 preload、无 webviewTag，权限请求默认拒绝。
- 网页内容属于 DeepSeek；插件只负责承载与恢复登录状态。

## 许可

MIT。架构与「登录保存/恢复」「主题同步」参考了社区开源实现（MIT）。
