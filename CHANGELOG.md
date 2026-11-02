# Changelog

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
