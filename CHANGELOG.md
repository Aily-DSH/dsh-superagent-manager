# Changelog

## 0.3.7

**每个实例用自己的会话目录，`error.sessionInUse` 不再出现。** DSH 的会话是单写者内核锁
（Windows 命名信号量 / POSIX flock），同一个会话被两个 DSH 进程打开时，后到的那个会报
「当前会话已被占用，可能是其他正在运行的 DSH 导致的」。实例和宿主共用 `~/.dsh/sessions`
时，面板里还会列出宿主的全部工作区——在面板里点一个宿主正在用的对话，就必然撞上这把锁。

- 实例 profile 的 `cordis.patch.yml` 现在给 `session-persistence-jsonl` 单独指定
  `root: <stateDir>/sessions`，实例只看得见自己的会话，和宿主、其他实例完全隔离。
- 首次启动会把宿主 `sessions/` 里属于该项目的 bucket（按克隆目录和 stateDir 的路径名）
  一次性复制进来，所以之前已有的对话仍然能在面板里打开；之后两边各写各的，不再互相锁。
- 想恢复原来的「共享会话」行为（也接受锁冲突），启动宿主时设
  `DSH_SUPERAGENT_SHARED_SESSIONS=1`。
- 已有实例需要重启一次（停用再启用）才会换到自己的会话目录。

## 0.3.6

**插件清单会自动跟上宿主（压缩插件不再漏挂）。** 实例的 profile 只在**启动时**写一次
`dsh.profile.bundles`，所以一个从 11-03 起就没重启过的实例，会一直用当时那份清单启动。
宿主后来装的 `billion-context`（上下文压缩代理）因此没有被实例加载：面板里的会话没有压缩，
44 轮就涨到 300 万 token，撞上 1M 窗口后**连压缩请求本身都超限**——每点一次「继续」都失败
在同一条错误上，自己救不了自己。

- `describe()` 新增 `staleBundles`：把「现在该有的 bundle」和「profile 文件里写的」比一遍，
  只报**缺少**的（profile 比宿主多不是问题，嵌套实例和测试 profile 不该被误报警）。
- 面板在标签栏下面显示琥珀色提示，列出缺的插件名并提示「停用再启用即可同步」。
- 启动时本来就重写 profile（`ensureProfile`），所以提示出现时，重启一次就对齐，会话不丢。

> 本次已就地把 `superagent-swordandgrain` / `superagent-monopoly2d` 的 profile 补齐到 18 个
> bundle（与 `superagent-tap` 一致），重启这两个实例即可让压缩生效。

## 0.3.5

**会话看得见（工作区重新登记）。** 实例是独立进程：它新建的对话立刻写进
`DSH_HOME/sessions/<目录桶>/<会话>/`，但"哪个工作区拥有哪些会话"是另一份登记表
（`storages/workspace.json` 的 `sessionIds`）。实例进程按自己的快照写这份表，主界面按自己的
快照读，于是磁盘上有内容、两边列表里都没有。

- 新增 `POST /api/dsh-superagent-manager/sync-sessions`：扫描实例目录桶里的会话文件，把工作区
  没登记过的**顶层会话**逐条 `attachSession` 补进去（工作区自身会用规范化 cwd 校验归属，
  桶对不上只会失败，不会串登记）。
- 跳过 `origin=subagent` / 带 `parentSession` 的派生会话——它们是子代理跑出来的，
  登记进去会在列表里塞满"你是……审查员"这类条目。
- 顺序：从旧到新登记，因为 `attachSession` 是前插，新的最后进、正好落在最上面。
- 面板新增 `同步会话` 按钮（显示本次登记条数），并**打开面板时自动跑一次**（60 秒节流，
  因为每次登记都会重写登记表）。
- `mirror.js` 的会话条目补上 `origin` / `parentSession`，供上面的过滤使用。

**同名工作区去歧义。** 实例的克隆目录和你本机的项目目录可以都叫 `SwordAndGrain`，而侧边栏只显示
标题，于是"同一个名字两个列表不一样"。

- 克隆目录的工作区自动改名为 `<项目名>（实例克隆）`，只在标题仍是自动生成的项目名时改一次；
  手工改过的标题不动，指向真实项目目录的工作区永远不动（判定依据是路径是否在管理器 stateDir 里）。
- 改名在创建实例时和每次 `同步会话` 时都会检查一次，所以老实例不用重建也能修好。

## 0.3.4

面板改成「常驻」，把每次点开都要重载的问题去掉。

- **根因**：面板是 `main` 槽位的一个入口，切到设置 / 对话 / 别的面板时 React 会卸载
  组件，JSX 里的 `<iframe>` 随组件一起销毁；再点回来三份内嵌客户端就得重新启动。
  原来的「首次打开才挂载」还让第一次点某个标签也必然白屏一次。
- **改法**：iframe 移出 React 树，放进挂在 `document.body` 上的 `[data-dsm-frames]`
  固定层（跟随面板 box 的 `getBoundingClientRect` 定位，`ResizeObserver` + 250ms 校正
  应对侧边栏折叠与窗口缩放）。React 只决定「哪些 frame 存在、哪个可见、哪个重载」，
  不再拥有它们的生命周期；组件卸载只把层 `display:none`，节点与文档状态全部保留。
- **全部预挂载**：运行中的实例在面板首屏就一起挂载，切标签只切 `display`，
  不再有「第一次点开等一下」。
- **只有刷新才重载**：去掉「离开页面超过 20 秒自动刷新当前面板」的逻辑；
  `刷新` 按钮重建当前实例的 iframe 节点，其他实例一个都不动（实测节点身份不变）。
- 重挂载时列表还没到（`data === null`）不参与对账，避免用空列表把仍在层里的
  iframe 全删掉 —— 这正是重挂载瞬间「看起来又重启了一次」的来源。

实测（headless Chrome + CDP，真实客户端）：首屏 2 个运行实例就位；离开面板再回来，
两个 iframe 的探针标记都还在；切标签只换 `display`；点刷新后只有当前实例的标记消失。

## 0.3.3

修 0.3.2 的回归：Super Agent 面板整块变成一行 `cross-site request`。

- **根因**：桌面端前端不是从 `http://127.0.0.1:<port>` 加载的，而是自定义协议
  `dsh-app://app`（见 `crash-*-web-boot.log` 里的 `dsh-app://app/assets/index-*.js`）。
  0.3.2 的 `requestGuard` 把 `Sec-Fetch-Site` 当硬闸门，只认
  `same-origin` / `same-site` / `none`；而 `dsh-app://app` 里嵌 `http://127.0.0.1:4310`
  的 iframe，按 Chromium 的 site 定义恒为 `cross-site` —— 于是宿主自己嵌自己的面板
  被自己拦掉，`/sa` 与独立端口代理都是 403。
- **改法**：不再用 `Sec-Fetch-Site` 判死。防护改由两条硬校验承担——回环 Host
  （挡 DNS rebinding）与受信 Origin（挡跨源 fetch/XHR，端口必须与 Host 一致）。
  跨站嵌入改用 `Referer` 识别：真实网页嵌进来会带自己的 origin，一律 403；
  桌面壳带 `dsh-app://` 或不带，放行。
- **iframe** 增加 `referrerPolicy="origin"`，让代理能稳定区分「壳嵌入」与「网站嵌入」。
- **WebSocket**：`upgradeGuard` 同样接受 `dsh-app://` / `file:` 的 Origin。

已知取舍：`<iframe referrerpolicy="no-referrer">` 能绕过 Referer 这一层（跨站 iframe
读不到 DOM，但能触发页面内操作）。要彻底堵住需要给代理加 `SameSite=Strict` 的
一次性凭据，属于下一步，见 README「安全边界」。

## 0.3.2

按审查报告（2026-11-04）修 4 个 P1 与 4 项高风险问题：

- **停止判断**：健康探针失败不再等于「已停止」。改为先看 TCP 监听与 PID，再用
  `Get-CimInstance` 核对命令行是否属于本实例（`--profile` / `--port` / stateDir），
  核不出来的端口占用报「无法确认」并拒绝终止；只有确认端口与 PID 都消失才清锁。
  `stopInstance` 现在返回 `stopped` / `confirmed` / `reason` / `identity`。
- **移除保护**：`/remove` 先停止，**停止未确认时返回 409 且不删文件、不注销记录**；
  删除范围限定为管理器自己的目录（manager root 下的实例目录、按 id 生成的 profile），
  用户自己的项目目录永不删除；逐目录记录结果并回报保留项。
- **注册表并发**：所有写入串行化（`withRegistry`），长操作结束后只 patch 自己那一条
  （`patchInstance` / `addInstance` / `dropInstance`），不再整表写回；`/instances` 的
  自动修复字段也改成逐条 patch。并发「停止 A + 改 A 颜色 + 新建 B」三者都保留。
- **仓库唯一性**：显示名与仓库名分离，中文名等无 ASCII 主干的名字退化为
  `project-<随机短ID>`；已存在的仓库不再静默复用，须显式「接入已有仓库」（`adopt`）。
  新增 `/preview`：建仓前展示完整 owner/repo、可见性、本地目录与审批人。
- **授权**：移除硬编码的 `SolaNoKan` 默认协作者；operator 由请求字段或
  `SUPERAGENT_MANAGER_OPERATOR` 显式给出，邀请失败会回传并在 UI 提示。
- **请求校验**：管理 API、`/sa` 代理与 WebSocket 升级补 Host / Origin / `Sec-Fetch-Site`
  校验（回环之外的 Origin、跨站请求、DNS rebinding 的 Host 一律 403）。
- **面板**：刷新只重载当前实例的 iframe（每实例独立 refreshKey）；对话镜像切换时立即
  清空旧内容并显示「正在切换」，轮询失败保留旧数据并标「连接中断 · 旧数据」；状态细化
  为 运行中 / 未就绪 / 不可达 / 启动中 / 停止中 / 上次操作失败，并把「期望运行」与
  「实际运行」分开；端口、profile、PID 收进「诊断详情」；移除改成每实例对话框且默认
  保留文件；补 focus-visible 焦点环、色块 22px 点击区、checkbox 关联 label、aria-live
  播报；面板标题显示版本号。

## 0.3.1

- 实例未运行时，面板内嵌页不再返回裸 503/502，而是显示「没在运行」的占位页，提示去
  「设置 → Super Agent 管理」点启动；只在文档请求（`/` + `text/html`）上探测端口，
  避免每个静态资源都多一次健康检查。
- 新增 `tools/patch-sleeping-page.mjs`（把该行为补丁应用到 `lib/index.js` 的可复现脚本）。

## 0.3.0

- 面板内每个实例改用独立子域（`http://<id>.localhost:<port>/sa/<id>/`）加载，实例之间的
  `localStorage` / IndexedDB / Cookie 不再共享，也不再依赖同源 DOM 点击去选工作区。
- 面板改为懒加载 iframe：只有打开过的标签页才挂载，切换标签不会重建已加载页面。
- 标签页新增手动启用 / 停用开关（`role="switch"`），与设置页状态通过
  `dsh-superagent-manager:instances-changed` 事件同步；工具栏新增当前标签页的停用 / 启用按钮。
- 停止实例更可靠：先按端口查找 PID，再回退到注册表里记录的 PID；`taskkill` 不可用时退回
  `process.kill`；未在运行 / 启动中的实例按「已停止」处理，只有确认停止才清除自动恢复标记。
- 清理未使用的 in-process 旧代码与导入。

## 0.2.0

- 每个项目一个独立 `dsh web` 进程：创建仓库、克隆、注册侧边栏工作区、写入实例配置、启动、
  停止、删除。
- `/sa/<id>/` 反向代理（含 WebSocket 中继）与 token→Cookie 交换，面板内嵌实例 UI。
- 侧边栏工作区颜色、实例负载、自动恢复上次运行的实例、手工创建的工作区自动认领。
