# dsh-superagent-manager

一个 DeepSeek Harness（DSH）插件：在**同一个客户端**里管理多个 [`dsh-superagent`](https://github.com/deepseek-ai/dsh-superagent-prototype) 项目。

每个项目对应一个独立的 `dsh web` 进程（独立端口、独立 stateDir、独立 profile），由本插件负责：

- 一键创建 GitHub 仓库 + 本地 clone + 脚手架；
- 在客户端侧边栏注册该项目的工作区（带颜色标记）；
- 启动 / 停止 / 删除实例；
- 把实例 UI 代理到客户端内的 **Super Agent** 面板：一个项目一个标签页，支持手动启用 / 停用（与设置页状态同步）；
- 每个实例使用独立子域 `http://<id>.localhost:<port>`，浏览器存储（localStorage / IndexedDB / Cookie）互相隔离；
- 客户端重启后自动恢复上次运行的实例。

> 这是「同一客户端内迂回运行多个 Super Agent」的方案 A：上游 `dsh-superagent` 一个实例只管理一个 `repository`，因此每个项目使用自己的 `dsh web` 进程，再由本插件统一管控和嵌入。原生单进程多实例（方案 C）需要上游改造，暂不在此插件范围内。

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| DSH | `>= 0.2.1-rc.2`（`engines.dsh`） |
| `dsh-superagent` | 同一个 profile 中已安装（本插件以它作为子进程的 bundle，并从已安装的 profile 复制配置） |
| GitHub CLI | `gh` 已登录，且对本插件用于创建仓库的账号有 `repo` 权限 |
| 平台 | Windows（实例进程管理使用 `taskkill` / `netstat`） |

## 安装

```bash
# 1. 加入 profile（link 指向上游 dsh-superagent 的 checkout 也可以）
dsh plugin --profile <profile> add link:/path/to/dsh-superagent-manager

# 2. 确认 profile bundle 列表包含本插件（package.json）
#    "dsh": { "profile": { "bundles": [
#      "@deepseek-ai/dsh-base",
#      "@deepseek-ai/dsh-web-app",
#      "dsh-superagent",
#      "dsh-superagent-manager"
#    ] } }
```

包内的 `cordis.patch.yml` 会把自己插入 Cordis 组合；`dsh.client.platform = web` 让客户端加载面板 UI。修改 `lib/` 下的代码后需要重启客户端进程（宿主插件在启动时加载），浏览器刷新只能更新面板 UI。

## 使用

1. 打开 **设置 → 插件 → Super Agent 管理**：填写项目名（可选：owner / 仓库名 / 是否私有），点击创建。
   插件会创建或复用 GitHub 仓库，把仓库 clone 到 `$DSH_HOME/state/<id>/repos/<repo>`，在侧边栏生成同名工作区，并启动实例。
2. 左侧点击 **Super Agent** 打开面板：每个项目一个标签页。
   - 标签右侧的开关 = 启用 / 停用该实例，与设置页状态同步；
   - `刷新` 重新拉取实例状态，`停用 / 启用` 对当前标签页操作，`新标签页打开` 直接访问代理地址；
   - 每个实例只挂载已打开过的 iframe（懒加载），停用的实例保留最后一个画面。
3. 首次打开某个实例时，实例 UI 在自己的子域里，可正常登录/选择工作区，且不会污染客户端本体的 localStorage。

## HTTP API

全部挂在客户端同源前缀 `/api/dsh-superagent-manager` 下，仅接受回环地址请求。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/instances` | 实例列表（运行状态、端口、颜色、负载、workspace、viewer） |
| POST | `/create` | 创建项目，body：`{ name, owner?, repoName?, private?, createRepo?, color? }` |
| POST | `/start` | 启动实例，body：`{ id }` |
| POST | `/stop` | 停止实例，body：`{ id }` |
| POST | `/remove` | 删除实例，body：`{ id, deleteFiles? }` |
| POST | `/color` | 修改侧边栏颜色，body：`{ id, color }` |

代理入口：`/sa/<id>/...` → `http://127.0.0.1:<port>/...`，包含 WebSocket（`/sa/<id>/api/remote.mux`）。实例的登录 token 由宿主服务端换取 Cookie 后转发，浏览器侧无需 token。

## 状态与配置

| 路径 / 变量 | 说明 |
| --- | --- |
| `$DSH_HOME/state/superagent-manager/instances.json` | 实例注册表 |
| `$DSH_HOME/state/<id>/` | 实例 stateDir（含 `repos/<repo>`、`web.log`、orchestrator 数据） |
| `$DSH_HOME/profiles/<id>/` | 实例 profile（bundle、端口、stateDir、node_modules junction） |
| `DSH_SUPERAGENT_MANAGER_HOME` | 覆盖注册表根目录（默认 `$DSH_HOME/state`），便于隔离测试 |
| `SUPERAGENT_MANAGER_OPERATOR` | 实例初始化时写入的 operator，默认 `SolaNoKan` |

## 架构

```text
DSH client (this plugin)
├─ /api/dsh-superagent-manager/*   registry + lifecycle
├─ /sa/<id>/*                      reverse proxy ─┬─→ dsh web :3090 (project A)
│                                                ├─→ dsh web :3091 (project B)
│                                                └─→ dsh web :3092 (project C)
└─ client UI: sidebar color + "Super Agent" stage panel
   └─ iframe http://<id>.localhost:<port>/sa/<id>/   (per-origin storage)
```

实例是 detached 子进程：客户端退出后仍在运行，下次启动由 `autoResume` 接管。

## 限制

- 一个项目一个进程 / 端口；实例数量受端口与内存约束。
- 上游 `dsh-superagent` 只支持单个 `repository`，因此不支持「一个实例管多个仓库」。
- 进程控制依赖 Windows 命令；其他平台需要替换 `taskkill` / `netstat` 相关实现。

## 开发

```
lib/index.js    宿主插件：注册表、创建流程、进程生命周期、反向代理、WebSocket 转发
lib/client.js   客户端 UI：设置页、侧边栏颜色、Super Agent 面板（标签页 / 开关）
cordis.patch.yml 自插入组合补丁
```

```bash
node --check lib/index.js
node --check lib/client.js
```

## License

MIT
