# dsh-superagent-manager

[![dsh-plugin](https://img.shields.io/badge/GitHub%20topic-dsh--plugin-3b82f6)](https://github.com/topics/dsh-plugin) [![awesome-dsh-plugins](https://img.shields.io/badge/awesome--dsh--plugins-PR%20open-6b7280)](https://github.com/cccakeee/awesome-dsh-plugins)


> ⚠️ **自用测试版（personal-use beta）**：这个插件是作者日常自用的工具，不是稳定发行版。
> 它需要拉起子进程、改写工作区登记表、代理 HTTP 与 WebSocket，实际使用中可能遇到意料之外的
> bug 和报错（实例起不来、面板白屏、代理 401/断流、会话登记错位等）。遇到问题先试「停用 → 启用」
> 或重启桌面客户端；重要项目请保留独立副本，不要只把唯一的仓库放在实例克隆目录里。

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

1. 打开 **设置 → 插件 → Super Agent 管理**：填写项目名（可选：owner / 仓库名 / 审批人 / 是否私有），点击
   **下一步：确认仓库**——先看清完整的 `owner/repo`、可见性、本地目录与审批人，再点 **确认创建**。
   仓库已存在时不会静默复用，只会给出 **接入已有仓库** 这一个选项。
   插件会创建 GitHub 仓库，把仓库 clone 到 `$DSH_HOME/state/<id>/repos/<repo>`，在侧边栏生成工作区，并启动实例。
   克隆目录的工作区标题是 **`<项目名>（实例克隆）`**，这样和你本机同名项目的工作区不会看起来像同一个；
   你手动改过的标题不会被覆盖，指向真实项目目录的工作区也不会被改名。
   项目名与仓库名是两件事：中文名没有 ASCII 主干时会生成 `project-<随机短ID>`，因此不同项目不会落到同一个仓库。
   如果填的是 **已有项目目录**：目录本身是 GitHub 检出时沿用它的 `origin` 仓库；只是普通文件夹时，
   实例照样创建和启动，但 GitHub 来源保持关闭（没有仓库可监听），在实例面板里补上仓库后才开始接工单。
2. 左侧点击 **Super Agent** 打开面板：每个项目一个标签页。
   - 标签右侧的开关 = 启用 / 停用该实例，与设置页状态同步；
   - 所有**运行中**的实例在面板打开时就一起挂载，切换标签只是显示 / 隐藏，不会重新加载；
   - 离开面板（去设置、去对话）只是把面板层收起，iframe 仍然活着；再回来立刻可用；
   - `刷新` 是唯一会重新加载的动作，且只重载**当前**项目，其余标签页不重载、滚动位置与输入保留；
   - `同步会话` 把实例里新建、但工作区还没登记的对话补进它的工作区，登记完侧边栏（外层对话区）立刻能看到；
     打开面板时会自动跑一次（60 秒节流），按钮可以随时手动补跑，重复的会跳过；子代理派生的会话不会被登记。
     注意：会话属于它发生时的那个目录，实例在克隆目录里工作，所以这些对话登记在**实例的工作区**里，
     不会跑到你本机同名项目的工作区下面；
   - `停用 / 启用` 对当前标签页操作，`新标签页打开` 直接访问代理地址；
   - `对话` 在面板里直接看当前项目的对话（只读镜像）：左边是这个实例的对话列表，右边是时间线
     （用户 / 助手 / 思考过程 / 工具调用与结果 / 审批 / 待办），每 2 秒刷新，默认跟随到底部。
     它只读日志，不会打开或锁定实例里的会话，所以不会触发「当前会话已被占用」；要继续聊点
     `回到实例` 在嵌入界面里操作。
   - 停用的实例会被卸载而不是留下一张死页面，重新启用时加载一份新文档；
   - 实例的插件清单在**启动时**跟着宿主同步（`bundle` 列表取自宿主 profile，去掉只属于主窗口的几条）。
     所以宿主新装的插件（比如上下文压缩 `billion-context`）要重启实例才生效；没重启时面板会在标签栏下面
     显示一条琥珀色提示，列出还没加载的插件名。
3. 首次打开某个实例时，实例 UI 在自己的子域里，可正常登录/选择工作区，且不会污染客户端本体的 localStorage。
4. **客户端内项目（Super Agent）**：左侧「Superagent」是客户端自己的一个 Super Agent，只能绑定一个仓库。
   在设置页顶部的「客户端内项目」里选一个已管理的项目，点 **设为客户端项目**，它就会成为客户端里直接对话的那个；
   其余项目留在「Super Agent」面板，用 `对话` 只读查看。
   切换会改写客户端 Super Agent 的设置快照：先把 `orchestrator.sqlite*` 备份到 `$DSH_HOME/state/superagent/`，
   写入一个新版本（`settings-version:<n>`），并记住历史版本——下面的「恢复到旧设置」可以随时换回去。
   仓库缺失时会先 clone 到 `$DSH_HOME/state/superagent/repos/<repo>`。**切换后需要重启一次客户端**才生效。

### 移除一个实例

「移除」是每个实例各自的对话框，默认**保留**文件：先停止实例，停止没有确认就整体中止并返回 409，
一个字节都不会删。确认停止后才会注销记录、删掉插件生成的 profile；克隆目录与状态目录（含日志、
会话）只有勾选「同时删除」才会删，GitHub 仓库与你自己指定的项目目录永远不动。

## HTTP API

全部挂在客户端同源前缀 `/api/dsh-superagent-manager` 下。校验分两层：**回环 peer + 回环 Host**
（挡 DNS rebinding），以及**受信 Origin**——请求带 `Origin` 时必须是回环地址且端口与 Host 一致，
或者是桌面壳自己的 `dsh-app://` / `file:`；带 `Referer` 时其 origin 同样必须属于这两类。
其余一律 403。

这里刻意**不用 `Sec-Fetch-Site` 当闸门**：桌面端前端是从 `dsh-app://app` 加载的，它嵌的
`http://127.0.0.1:<proxyPort>` iframe 按 Chromium 的 site 定义永远是 `cross-site`，
拿它判死会把面板自己拦掉（0.3.2 的实际故障）。

已知边界：跨站 iframe 加上 `referrerpolicy="no-referrer"` 可以绕过 Referer 那一层——它读不到
页面 DOM，但能触发页面内的点击/表单。要彻底关闭这个口子，下一步应给代理加
`SameSite=Strict` 的一次性凭据，而不是继续堆请求头判断。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/instances` | 实例列表（运行状态、期望状态、端口、颜色、负载、workspace、viewer、版本） |
| POST | `/preview` | 预检：返回将要使用的 `owner/repo`、可见性、目录、审批人，以及仓库是否已存在；不产生任何副作用 |
| POST | `/create` | 创建项目，body：`{ name, owner?, repoName?, operator?, private?, createRepo?, localPath?, adopt?, color? }` |
| POST | `/start` | 启动实例，body：`{ id, operator? }` |
| POST | `/stop` | 停止实例，body：`{ id }`；停止未确认时返回 409 并附 `reason` |
| POST | `/remove` | 移除实例，body：`{ id, deleteFiles? }`；停止未确认时返回 409，且不删文件、不注销 |
| POST | `/color` | 修改侧边栏颜色，body：`{ id, color }` |

注册表的所有写入都经过同一个队列，长操作结束后只 patch 自己那一条记录，因此并发
「停止 A + 改 A 颜色 + 新建 B」不会互相覆盖。

代理入口：`/sa/<id>/...` → `http://127.0.0.1:<port>/...`，包含 WebSocket（`/sa/<id>/api/remote.mux`）。实例的登录 token 由宿主服务端换取 Cookie 后转发，浏览器侧无需 token。

## 状态与配置

| 路径 / 变量 | 说明 |
| --- | --- |
| `$DSH_HOME/state/superagent-manager/instances.json` | 实例注册表 |
| `$DSH_HOME/state/<id>/` | 实例 stateDir（含 `repos/<repo>`、`web.log`、`sessions/`、orchestrator 数据） |
| `$DSH_HOME/profiles/<id>/` | 实例 profile（bundle、端口、stateDir、session root、node_modules junction） |
| `DSH_SUPERAGENT_MANAGER_HOME` | 覆盖注册表根目录（默认 `$DSH_HOME/state`），便于隔离测试 |
| `DSH_SUPERAGENT_SHARED_SESSIONS=1` | 让实例与宿主共用 `$DSH_HOME/sessions`（旧行为；同一个对话不能同时在两边打开） |
| `SUPERAGENT_MANAGER_OPERATOR` | 实例初始化时写入的 operator（审批人 GitHub 账号）。**没有默认值**：不指定时不邀请任何协作者，GitHub 来源也不接受任何人的指令 |

### 会话目录是隔离的

每个实例的 profile 会把 `session-persistence-jsonl.root` 指到
`<stateDir>/sessions`，所以面板里只出现该实例自己的对话，不会列出宿主的工作区。这样也避免了
DSH 的单写者会话锁：同一个对话被两个 DSH 进程打开时，后到的那个只会报
`error.sessionInUse`（当前会话已被占用）。首次启动会把宿主 `sessions/` 里属于该项目的
bucket 一次性复制进来，历史对话仍然可见。

面板里的 `对话` 和侧边栏的「对话镜像」读的就是这份目录（隔离实例读 `<stateDir>/sessions`，
共享模式读 `$DSH_HOME/sessions`，两者都在时按会话 id 去重、隔离目录优先），所以隔离之后
不必重启或切回共享模式也能看历史。

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

## 与远程 / 移动插件共存（重要）

实例会继承客户端的 bundle 列表，但有两个 bundle **永远不会被复制进实例**：`ds-harness-remote`
（DeepSeek 远程连接）和 `dsh-go-workspace`（DSH Go 电脑互联）。

原因：这两个插件的身份都是按 `DSH_HOME` 里的设备密钥算的，而实例和客户端共用同一个 `~/.dsh`。
一旦实例也加载它们，就会有多个进程拿**同一个设备身份**去连服务器 / 抢同一个端口：

- `[dsh-remote] server control connection failed {"code":"CONNECTION_REPLACED"}`
- `[dsh-remote] Another instance is using this Host identity. Stop it or use a separate DSH_HOME; automatic reconnect is paused.`
- 严重时桌面壳直接报「应用无法启动或已意外停止」，或手机 App 里的电脑反复上下线
- `dsh-go-workspace` 还会抢 3443 端口 / 配对设备列表，出现端口被占或重复设备

因此：

1. **远程 / 移动连接只在客户端窗口里开，实例里不要装。** 本插件会自动把它们从实例清单里过滤掉。
2. 0.3.7 之前创建的实例，profile 里可能还留着这两个条目；面板会提示「插件清单里还带着只属于
   客户端的…」，点 **停用 → 启用** 让它重写 profile 即可（会话不丢）。
3. 如果确实需要在实例里也用远程能力，只能给该实例单独的 `DSH_HOME`（本插件暂不提供），
   否则两个进程不能同时在线。

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

## 生态与收录

- **GitHub topic**：[dsh-plugin](https://github.com/topics/dsh-plugin)——DSH 社区约定的插件标记，本仓库已加上
  `dsh` / `dsh-plugin` / `deepseek-harness` / `plugin` 等 topics。
- **社区目录**：已向 [cccakeee/awesome-dsh-plugins](https://github.com/cccakeee/awesome-dsh-plugins) 提交收录 PR；
  收录后可在 [deepseekharnessplugins.com](https://deepseekharnessplugins.com) 与
  [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 搜到。
- **客户端插件市场**：DSH 的「设置 → 插件市场」只读**配置里的索引 URL**（不搜 npm）。索引格式 1 的示例见
  [Aily-DSH/dsh-plugin-index](https://github.com/Aily-DSH/dsh-plugin-index)，把它的 jsDelivr 地址加进
  `dsh.profile.indexes` 即可在客户端内直接看到 dsh-superagent-manager。
- **查不到时**：npm / GitHub 搜索有索引延迟，新包一般 1–3 天；先用
  `dsh plugin --profile desktop add git+https://github.com/Aily-DSH/dsh-superagent-manager.git` 直接装。

