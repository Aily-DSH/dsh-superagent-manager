/**
 * dsh-superagent-manager — browser half.
 *
 * Seats a settings section ("Super Agent 管理") that creates one Super Agent
 * per project: a dedicated GitHub repository, a local clone and an isolated
 * `dsh --profile superagent-*` instance listening on its own port. The host
 * half owns repository creation, process control and health probes.
 *
 * @module dsh-superagent-manager/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-superagent-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-superagent-manager'
    const SETTINGS_SECTION = 'settings.section'
    const SECTION_ID = 'dsh-superagent-manager'
    const SECTION_ORDER = 154

    const LIST_PATH = 'api/dsh-superagent-manager/instances'
    const PREVIEW_PATH = 'api/dsh-superagent-manager/preview'
    const CREATE_PATH = 'api/dsh-superagent-manager/create'
    const START_PATH = 'api/dsh-superagent-manager/start'
    const STOP_PATH = 'api/dsh-superagent-manager/stop'
    const REMOVE_PATH = 'api/dsh-superagent-manager/remove'
    const SYNC_PATH = 'api/dsh-superagent-manager/sync-sessions'

    /** Creating an instance clones a repository and boots a process. */
    const CREATE_TIMEOUT_MS = 300000
    const FETCH_TIMEOUT_MS = 30000

    const dictionaries = {
      zh: {
        'title': 'Super Agent 管理',
        'desc': '每个项目一个独立的 Super Agent：独立 GitHub 仓库，在自己的工作区里对话，互不影响。',
        'create': '新建项目',
        'name': '项目名称',
        'nameHint': '例如：骰子棋旅',
        'repo': 'GitHub 仓库名',
        'repoHint': '留空按项目名生成',
        'owner': '仓库归属',
        'private': '私有仓库（推荐）',
        'workspace': '运行方式',
        'workspaceHint': '每个项目独立进程、独立端口，点「打开面板」使用',
        'submit': '一键创建',
        'creating': '正在建仓库、克隆并启动实例，大约 40 秒…',
        'instances': '实例',
        'empty': '还没有实例。先在上面创建一个项目。',
        'running': '运行中',
        'stopped': '已停止',
        'unready': '未就绪',
        'open': '运行中',
        'start': '启动',
        'stop': '停止',
        'remove': '移除',
        'refresh': '刷新',
      },
      en: {
        'title': 'Super Agent',
        'desc': 'One Super Agent per project: its own GitHub repository, talking in its own workspace here.',
        'create': 'New project',
        'name': 'Project name',
        'nameHint': 'e.g. Dice Quest',
        'repo': 'GitHub repository',
        'repoHint': 'Generated from the project name when empty',
        'owner': 'Repository owner',
        'private': 'Private repository (recommended)',
        'workspace': 'Workspace',
        'workspaceHint': 'Appears in the sidebar after creation',
        'submit': 'Create',
        'creating': 'Creating the repository, cloning and starting (about 30 s)…',
        'instances': 'Instances',
        'empty': 'No instance yet — create a project above.',
        'running': 'Running',
        'stopped': 'Stopped',
        'unready': 'Not ready',
        'open': 'Open panel',
        'start': 'Start',
        'stop': 'Stop',
        'remove': 'Remove',
        'refresh': 'Refresh',
      },
    }

    const COLOR_PATH = 'api/dsh-superagent-manager/color'
    const PALETTE_FALLBACK = ['#5B8DEF', '#F0633C', '#2FB344', '#B15CE0', '#E8A33D', '#12A5A5', '#D94F8A', '#7A8CA0']
    const COLOR_EVENT = 'dsh-superagent-manager:colour-changed'
    // Fired after any mutation (create / start / stop / remove / colour) so the
    // settings panel and the Super Agent stage stay in sync without a full reload.
    const INSTANCES_EVENT = 'dsh-superagent-manager:instances-changed'

    function notifyInstancesChanged() {
      try { window.dispatchEvent(new CustomEvent(INSTANCES_EVENT)) } catch { /* no listeners */ }
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px' },
      header: { display: 'flex', flexDirection: 'column', gap: '6px' },
      title: { fontSize: '15px', fontWeight: 600 },
      hint: { fontSize: '12px', opacity: 0.62, lineHeight: 1.55 },
      card: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: '5px', flex: '1 1 190px', minWidth: '0' },
      label: { fontSize: '12px', opacity: 0.72 },
      input: { height: '32px', padding: '0 10px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px', outline: 'none' },
      switchRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' },
      button: { height: '32px', padding: '0 14px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      buttonPrimary: { height: '32px', padding: '0 16px', borderRadius: '8px', border: '1px solid transparent', background: '#4b6bfb', color: '#fff', fontSize: '13px', cursor: 'pointer', fontWeight: 500 },
      buttonDanger: { height: '32px', padding: '0 14px', borderRadius: '8px', border: '1px solid rgba(214,69,69,0.65)', background: 'rgba(214,69,69,0.12)', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      instanceRow: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 0', borderTop: '1px solid rgba(128,128,128,0.16)' },
      instanceMain: { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 },
      instanceName: { fontSize: '13px', fontWeight: 600 },
      meta: { fontSize: '12px', opacity: 0.62, display: 'flex', gap: '10px', flexWrap: 'wrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '1px 8px', borderRadius: '999px', border: '1px solid rgba(128,128,128,0.3)' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
      error: { fontSize: '12px', color: '#d64545', whiteSpace: 'pre-wrap' },
      notice: { fontSize: '12px', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.25)', lineHeight: 1.55 },
      dot: { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block' },
      swatches: { display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' },
      // 22px hit area around a 14px mark: the swatch was 14px of pure click target.
      swatch: { width: '22px', height: '22px', borderRadius: '5px', cursor: 'pointer', padding: 0, border: 0, background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      swatchMark: { width: '14px', height: '14px', borderRadius: '4px', display: 'block' },
      diagnostics: { fontSize: '11px', opacity: 0.66, marginTop: '2px' },
      summary: { cursor: 'pointer', fontSize: '11px', opacity: 0.66 },
      dialog: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40 },
      dialogBody: { background: 'var(--dsh-surface, #fff)', color: 'inherit', border: '1px solid rgba(128,128,128,0.3)', borderRadius: '12px', padding: '18px 20px', width: 'min(460px, calc(100vw - 40px))', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 18px 48px rgba(0,0,0,0.22)' },
      dialogTitle: { fontSize: '14px', fontWeight: 600 },
      list: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.7, opacity: 0.8 },
    }

    /**
     * Inline styles cannot express :focus-visible, and the inputs set outline:none to
     * kill the browser default. One stylesheet hands the focus ring back without
     * making a mouse click paint a ring.
     */
    const PANEL_CSS = [
      '[data-sm-focusable]:focus-visible{outline:2px solid #4b6bfb;outline-offset:2px}',
      '[data-sm-switch]:focus-visible{outline:2px solid #4b6bfb;outline-offset:2px}',
    ].join('')

    function ensurePanelCss() {
      try {
        if (document.querySelector('[data-sm-panel-css]')) return
        const style = document.createElement('style')
        style.setAttribute('data-sm-panel-css', '')
        style.textContent = PANEL_CSS
        ;(document.head || document.body).appendChild(style)
      } catch {
        // Without the stylesheet the panel still works, just without the focus ring.
      }
    }

    async function apiFetch(path, options) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), (options && options.timeoutMs) || FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(path, {
          method: (options && options.method) || 'GET',
          headers: { 'content-type': 'application/json' },
          body: options && options.body ? JSON.stringify(options.body) : undefined,
          credentials: 'same-origin',
          signal: controller.signal,
        })
        const text = await response.text()
        let payload = null
        try {
          payload = text ? JSON.parse(text) : null
        } catch {
          payload = { error: text.slice(0, 400) }
        }
        if (!response.ok) {
          const message = payload && payload.error ? payload.error : 'request failed with ' + response.status
          throw new Error(message)
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    function formatLoad(load) {
      if (!load) return null
      return '执行中 ' + (load.running || 0) + ' / ' + (load.maxWorkers || 0) + ' · 排队 ' + (load.queued || 0)
    }

    /**
     * Six states instead of two. "Not running" used to cover four different
     * situations — deliberately stopped, still booting, shutting down, and crashed
     * behind a dead health check — so the operator could not tell a bug from a click.
     * "Should run" (desiredRunning) is kept separate from "does run" (running).
     */
    function statusOf(instance, phase) {
      if (phase === 'starting') return { key: 'starting', label: '启动中', color: '#4b6bfb' }
      if (phase === 'stopping') return { key: 'stopping', label: '停止中', color: '#4b6bfb' }
      if (phase === 'failed') return { key: 'failed', label: '上次操作失败', color: '#d64545' }
      if (instance.running) {
        return instance.problem
          ? { key: 'unready', label: '未就绪', color: '#e0a21a' }
          : { key: 'running', label: '运行中', color: '#2fbf71' }
      }
      if (instance.desiredRunning) return { key: 'unreachable', label: '不可达', color: '#e0a21a' }
      return { key: 'stopped', label: '已停止', color: 'rgba(128,128,128,0.6)' }
    }

    function InstanceRow({ instance, onStart, onStop, onRemove, onColor, palette, busy, phase }) {
      const status = statusOf(instance, phase)
      const running = Boolean(instance.running)
      const pending = phase === 'starting' || phase === 'stopping'
      return h('div', { style: styles.instanceRow },
        h('div', { style: styles.instanceMain },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', {
              style: { ...styles.dot, width: '9px', height: '9px', background: instance.color || '#7A8CA0', boxShadow: '0 0 0 2px rgba(128,128,128,0.16)' },
              title: '工作区颜色 ' + (instance.color || '默认'),
            }),
            h('span', { style: styles.instanceName }, instance.name),
            h('span', { style: styles.badge, 'aria-label': '状态：' + status.label },
              h('span', { style: { ...styles.dot, background: status.color } }),
              status.label,
            ),
            instance.load ? h('span', { style: { ...styles.badge, opacity: 0.75 } }, formatLoad(instance.load)) : null,
          ),
          h('div', { style: styles.meta },
            h('span', null, instance.repo || '未设置仓库'),
            instance.accounts && instance.accounts.agent ? h('span', null, '智能体 ' + instance.accounts.agent) : null,
            instance.url
              ? h('a', { href: instance.url, target: '_blank', rel: 'noreferrer', style: { color: '#4B6BFB', textDecoration: 'none' } }, '打开面板')
              : null,
          ),
          status.key === 'unreachable'
            ? h('div', { style: styles.diagnostics }, '期望运行，但没有回应健康检查：可能还在启动、已经崩溃，或被别的进程占用了端口。')
            : null,
          instance.problem ? h('div', { style: styles.error }, instance.problem.code || JSON.stringify(instance.problem)) : null,
          h('div', { style: styles.swatches, role: 'group', 'aria-label': '工作区颜色' },
            ...(palette || PALETTE_FALLBACK).map((color) => h('button', {
              key: color,
              type: 'button',
              'data-sm-focusable': '',
              title: '把工作区颜色改成 ' + color,
              'aria-label': '把 ' + instance.name + ' 的颜色改成 ' + color,
              'aria-pressed': String(instance.color || '').toUpperCase() === color ? 'true' : 'false',
              disabled: busy,
              style: { ...styles.swatch, opacity: busy ? 0.5 : 1 },
              onClick: () => onColor(instance, color),
            }, h('span', {
              style: {
                ...styles.swatchMark,
                background: color,
                outline: String(instance.color || '').toUpperCase() === color ? '2px solid rgba(75,107,251,0.85)' : '1px solid rgba(128,128,128,0.28)',
                outlineOffset: '1px',
              },
            }))),
          ),
          h('details', { style: styles.diagnostics },
            h('summary', { style: styles.summary }, '诊断详情'),
            h('div', null, '期望状态：' + (instance.desiredRunning ? '运行' : '停止')),
            h('div', null, '端口：' + (instance.port || '待分配') + (instance.proxyPort ? ' · 面板 ' + instance.proxyPort : '')),
            h('div', null, 'profile：' + instance.id + ' · PID：' + (instance.pid || '—')),
            h('div', null, '状态目录：' + (instance.stateDir || '—')),
            h('div', null, '项目目录：' + (instance.clone || '—')),
          ),
        ),
        h('div', { style: styles.actions },
          running || pending
            ? h('button', {
              type: 'button',
              'data-sm-focusable': '',
              style: { ...styles.button, opacity: pending ? 0.6 : 1 },
              disabled: busy || pending,
              onClick: () => onStop(instance),
            }, phase === 'stopping' ? '停止中…' : '停止')
            : h('button', {
              type: 'button',
              'data-sm-focusable': '',
              style: { ...styles.buttonPrimary, opacity: pending ? 0.6 : 1 },
              disabled: busy || pending,
              onClick: () => onStart(instance),
            }, phase === 'starting' ? '启动中…' : '启动'),
          h('button', {
            type: 'button',
            'data-sm-focusable': '',
            style: { ...styles.button, opacity: busy ? 0.5 : 1 },
            disabled: busy,
            onClick: () => onRemove(instance),
          }, '移除'),
        ),
      )
    }

    function SuperAgentManagerPanel() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [busy, setBusy] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [form, setForm] = React.useState({ name: '', repoName: '', owner: '', operator: '', private: true, localPath: '' })
      // The creation is previewed before anything is created: the operator sees the
      // exact owner/repository, the visibility and the folder first.
      const [preview, setPreview] = React.useState(null)
      // One dialog per instance; "keep the files" is decided per removal, not by one
      // global checkbox that silently applies to every later project.
      const [removing, setRemoving] = React.useState(null)
      const [removeFiles, setRemoveFiles] = React.useState(false)
      const [phases, setPhases] = React.useState({})

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, loading: true, error: null }))
        try {
          const data = await apiFetch(LIST_PATH)
          setState({ loading: false, error: null, data })
        } catch (error) {
          setState({ loading: false, error: error && error.message ? error.message : String(error), data: null })
        }
      }, [])

      React.useEffect(() => { ensurePanelCss() }, [])
      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        // A tab switched on/off in the Super Agent stage flips the same registry the
        // settings page renders, so listen for it and re-read instead of going stale.
        const onChange = () => { void load() }
        window.addEventListener(INSTANCES_EVENT, onChange)
        return () => window.removeEventListener(INSTANCES_EVENT, onChange)
      }, [load])

      const setPhase = React.useCallback((id, phase) => {
        setPhases((current) => {
          const next = { ...current }
          if (phase) next[id] = phase
          else delete next[id]
          return next
        })
      }, [])

      const act = React.useCallback(async (path, body, timeoutMs) => {
        setBusy(true)
        setMessage(null)
        try {
          const payload = await apiFetch(path, { method: 'POST', body, timeoutMs })
          await load()
          notifyInstancesChanged()
          return payload
        } catch (error) {
          setMessage({ kind: 'error', text: error && error.message ? error.message : String(error) })
          return null
        } finally {
          setBusy(false)
        }
      }, [load])

      const recolor = React.useCallback(async (instance, color) => {
        const payload = await act(COLOR_PATH, { id: instance.id, color }, 20000)
        if (payload) {
          try { window.dispatchEvent(new CustomEvent(COLOR_EVENT)) } catch { /* no listener */ }
        }
      }, [act])

      const startOne = React.useCallback(async (instance) => {
        setPhase(instance.id, 'starting')
        const payload = await act(START_PATH, { id: instance.id }, 180000)
        // A failed start leaves the "failed" mark instead of pretending the instance
        // went back to being deliberately stopped.
        setPhase(instance.id, payload ? '' : 'failed')
        return payload
      }, [act, setPhase])

      const stopOne = React.useCallback(async (instance) => {
        setPhase(instance.id, 'stopping')
        const payload = await act(STOP_PATH, { id: instance.id }, 60000)
        setPhase(instance.id, payload ? '' : 'failed')
        return payload
      }, [act, setPhase])

      const requestPreview = React.useCallback(async () => {
        const name = form.name.trim()
        if (!name) {
          setMessage({ kind: 'error', text: '请先填写项目名称。' })
          return
        }
        setMessage(null)
        setBusy(true)
        try {
          const payload = await apiFetch(PREVIEW_PATH, {
            method: 'POST',
            body: {
              name,
              repoName: form.repoName.trim() || undefined,
              owner: form.owner.trim() || undefined,
              private: form.private,
              localPath: form.localPath.trim() || undefined,
              createRepo: !form.localPath.trim(),
              operator: form.operator.trim() || undefined,
            },
            timeoutMs: FETCH_TIMEOUT_MS,
          })
          setPreview(payload)
        } catch (error) {
          setMessage({ kind: 'error', text: error && error.message ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }, [form])

      const create = React.useCallback(async (adopt) => {
        if (!preview) return
        setCreating(true)
        setMessage(null)
        try {
          const payload = await apiFetch(CREATE_PATH, {
            method: 'POST',
            body: {
              name: preview.name,
              // Same name the preview displayed: what was confirmed is what gets created.
              repoName: preview.createRepo ? preview.repoName : (form.repoName.trim() || undefined),
              owner: preview.owner || undefined,
              operator: form.operator.trim() || undefined,
              private: preview.private,
              createRepo: preview.createRepo,
              adopt: Boolean(adopt),
              localPath: preview.localPath || undefined,
            },
            timeoutMs: CREATE_TIMEOUT_MS,
          })
          await load()
          notifyInstancesChanged()
          const repo = (payload && payload.repository) || (payload && payload.instance ? payload.instance.repo : preview.repo)
          const portNote = payload && payload.workspace && payload.workspace.port ? '端口 ' + payload.workspace.port + ' 已就绪' : '但实例还没起来'
          const extra = [
            payload && payload.configureError ? '配置没写完：' + payload.configureError : '',
            ...((payload && payload.warnings) || []),
          ].filter(Boolean)
          const kind = payload && (payload.configureError || (payload.warnings || []).length) ? 'warn' : 'ok'
          setMessage({ kind, text: '已创建：' + repo + '，' + portNote + (extra.length ? '。' + extra.join('；') : '') })
          setPreview(null)
          setForm({ name: '', repoName: '', owner: '', operator: form.operator, private: true, localPath: '' })
        } catch (error) {
          setMessage({ kind: 'error', text: error && error.message ? error.message : String(error) })
        } finally {
          setCreating(false)
        }
      }, [form.operator, form.repoName, load, preview])

      const confirmRemove = React.useCallback(async () => {
        if (!removing) return
        const target = removing
        setBusy(true)
        setMessage(null)
        try {
          const payload = await apiFetch(REMOVE_PATH, { method: 'POST', body: { id: target.id, deleteFiles: removeFiles } }, 90000)
          const notes = (payload && payload.notes) || []
          const failed = (payload && payload.files || []).filter((item) => !item.removed)
          setMessage({
            kind: failed.length ? 'warn' : 'ok',
            text: '已移除 ' + target.name + '。' + (notes.length ? notes.join('；') : '') + (failed.length ? '；有目录没删掉：' + failed.map((item) => item.path).join('、') : ''),
          })
          setRemoving(null)
          setRemoveFiles(false)
          await load()
          notifyInstancesChanged()
        } catch (error) {
          setMessage({ kind: 'error', text: error && error.message ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }, [load, removeFiles, removing])

      const data = state.data
      const viewer = data && data.viewer ? data.viewer : ''
      const instances = data && Array.isArray(data.instances) ? data.instances : []
      const palette = (data && data.palette) || PALETTE_FALLBACK
      const noticeColor = message ? (message.kind === 'error' ? '#d64545' : message.kind === 'warn' ? '#b8860b' : '#2fbf71') : 'inherit'
      const operatorPlaceholder = (data && data.defaults && data.defaults.operator) || '你的 GitHub 账号'

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h('div', { style: styles.title }, 'Super Agent 管理', data && data.version ? h('span', { style: { ...styles.hint, marginLeft: '8px' } }, 'v' + data.version) : null),
          h('div', { style: styles.hint }, '每个项目一个独立的 Super Agent：独立 GitHub 仓库、独立工作区，互不影响。'),
        ),
        h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, '新建项目'),
          h('div', { style: styles.row },
            h('label', { style: styles.field },
              h('span', { style: styles.label }, '项目名称'),
              h('input', {
                style: styles.input,
                'data-sm-focusable': '',
                value: form.name,
                placeholder: '例如：骰子棋旅',
                onChange: (event) => { setForm({ ...form, name: event.target.value }); setPreview(null) },
              }),
            ),
            h('label', { style: styles.field },
              h('span', { style: styles.label }, 'GitHub 仓库名（可选）'),
              h('input', {
                style: styles.input,
                'data-sm-focusable': '',
                value: form.repoName,
                placeholder: '留空自动生成唯一名',
                onChange: (event) => { setForm({ ...form, repoName: event.target.value }); setPreview(null) },
              }),
            ),
          ),
          h('div', { style: styles.row },
            h('label', { style: styles.field },
              h('span', { style: styles.label }, '仓库归属（可选）'),
              h('input', {
                style: styles.input,
                'data-sm-focusable': '',
                value: form.owner,
                placeholder: viewer || '默认用智能体账号',
                onChange: (event) => { setForm({ ...form, owner: event.target.value }); setPreview(null) },
              }),
            ),
            h('label', { style: styles.field },
              h('span', { style: styles.label }, '审批人账号（可选）'),
              h('input', {
                style: styles.input,
                'data-sm-focusable': '',
                value: form.operator,
                placeholder: operatorPlaceholder,
                onChange: (event) => setForm({ ...form, operator: event.target.value }),
              }),
              h('span', { style: styles.hint }, '只有这个 GitHub 账号的指令会被执行；留空则建好后到实例设置里补。'),
            ),
          ),
          h('label', { style: styles.field },
            h('span', { style: styles.label }, '已有项目目录（可选）'),
            h('input', {
              style: styles.input,
              'data-sm-focusable': '',
              value: form.localPath,
              placeholder: '例如：D:\\GC\\H5\\Tap —— 填了就接管这个目录，不建仓库、不克隆',
              onChange: (event) => { setForm({ ...form, localPath: event.target.value }); setPreview(null) },
            }),
          ),
          h('label', { style: styles.switchRow },
            h('input', {
              type: 'checkbox',
              'data-sm-focusable': '',
              checked: form.private,
              onChange: (event) => { setForm({ ...form, private: event.target.checked }); setPreview(null) },
            }),
            h('span', null, '私有仓库（推荐：智能体可以看到工作目录里的文件，私有仓库才不会把代码公开）'),
          ),

          // Confirmation step: the exact repository, its visibility, the folder and who
          // may approve. Nothing is created until this is acknowledged.
          preview
            ? h('div', { style: { ...styles.notice, display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('div', { style: { fontWeight: 600 } }, preview.createRepo ? '确认要创建这个仓库吗？' : '确认要接入吗？'),
              h('div', null, '仓库：' + preview.repo + (preview.createRepo ? (preview.private ? '（私有）' : '（公开）') : '')),
              h('div', null, '本地目录：' + (preview.localPath || preview.stateDir)),
              h('div', null, '审批人：' + (preview.operator || '未指定（GitHub 来源将不接受指令）')),
              preview.viewer ? h('div', { style: styles.hint }, '使用智能体账号 ' + preview.viewer + ' 操作 GitHub') : null,
              preview.exists === true
                ? h('div', { style: { ...styles.error, color: '#b8860b' } }, '这个仓库已经存在。可以直接接入它，但它里面的历史可能属于别的项目。')
                : null,
              preview.exists === null
                ? h('div', { style: { ...styles.error, color: '#b8860b' } }, '无法确认这个仓库是否存在（gh 未登录或网络不通），继续创建可能会失败。')
                : null,
              preview.instanceIdTaken
                ? h('div', { style: styles.error }, '已经有实例使用这个名称或这个仓库，请换一个项目名。')
                : null,
              h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                preview.exists === true
                  ? h('button', {
                    type: 'button',
                    'data-sm-focusable': '',
                    style: styles.buttonPrimary,
                    disabled: creating || preview.instanceIdTaken,
                    onClick: () => create(true),
                  }, creating ? '接入中…' : '接入已有仓库')
                  : h('button', {
                    type: 'button',
                    'data-sm-focusable': '',
                    style: { ...styles.buttonPrimary, opacity: creating || preview.instanceIdTaken ? 0.6 : 1 },
                    disabled: creating || preview.instanceIdTaken,
                    onClick: () => create(false),
                  }, creating ? '创建中…' : '确认创建'),
                h('button', {
                  type: 'button',
                  'data-sm-focusable': '',
                  style: styles.button,
                  disabled: creating,
                  onClick: () => setPreview(null),
                }, '取消'),
              ),
            )
            : null,

          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              'data-sm-focusable': '',
              style: { ...styles.buttonPrimary, opacity: creating || busy ? 0.6 : 1 },
              disabled: creating || busy || Boolean(preview),
              onClick: requestPreview,
            }, creating ? '创建中…' : preview ? '已确认' : '下一步：确认仓库'),
            creating ? h('span', { style: styles.hint }, '流程：建仓库 → 克隆 → 写配置 → 启动 → 健康检查。已完成的阶段会保留，失败可重试。') : null,
            viewer ? h('span', { style: styles.hint }, '智能体账号 ' + viewer) : null,
          ),
        ),
        message
          ? h('div', {
            style: { ...styles.notice, color: noticeColor },
            role: message.kind === 'error' ? 'alert' : 'status',
            'aria-live': message.kind === 'error' ? 'assertive' : 'polite',
          }, message.text)
          : null,
        h('div', { style: styles.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: styles.cardTitle }, '实例' + (instances.length ? '（' + instances.length + '）' : '')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              h('button', { type: 'button', 'data-sm-focusable': '', style: styles.button, disabled: busy || state.loading, onClick: load }, '刷新'),
            ),
          ),
          state.error ? h('div', { style: styles.error, role: 'alert' }, state.error) : null,
          state.loading && !instances.length ? h('div', { style: styles.hint }, '加载中…') : null,
          !state.loading && !state.error && !instances.length ? h('div', { style: styles.hint }, '还没有实例。先在上面创建一个项目。') : null,
          instances.map((instance) => h(InstanceRow, {
            key: instance.id,
            instance,
            busy,
            phase: phases[instance.id] || '',
            onStart: startOne,
            onStop: stopOne,
            onRemove: (item) => { setRemoving(item); setRemoveFiles(false) },
            onColor: recolor,
            palette,
          })),
        ),
        removing
          ? h('div', { style: styles.dialog, role: 'dialog', 'aria-modal': 'true', 'aria-label': '移除实例' },
            h('div', { style: styles.dialogBody },
              h('div', { style: styles.dialogTitle }, '移除「' + removing.name + '」'),
              h('div', { style: styles.hint }, '移除会先停止实例；停止没有确认时不会删除任何东西。'),
              h('ul', { style: styles.list },
                h('li', null, '实例记录：删除'),
                h('li', null, '工作区入口：删除（项目目录本身不动）'),
                h('li', null, '由管理器生成的 profile：删除'),
                h('li', null, 'GitHub 仓库：保留'),
                removing.local
                  ? h('li', null, '你的项目目录 ' + removing.clone + '：保留')
                  : h('li', null, '克隆目录 ' + (removing.clone || '—') + '：' + (removeFiles ? '删除' : '保留')),
                h('li', null, '状态目录 ' + (removing.stateDir || '—') + '（含日志与克隆）：' + (removeFiles ? '删除' : '保留')),
              ),
              h('label', { style: styles.switchRow },
                h('input', {
                  type: 'checkbox',
                  'data-sm-focusable': '',
                  checked: removeFiles,
                  disabled: Boolean(removing.local),
                  onChange: (event) => setRemoveFiles(event.target.checked),
                }),
                h('span', null, removing.local ? '本地项目目录不会被删除' : '同时删除本地克隆和状态目录（日志、会话一并删除）'),
              ),
              h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
                h('button', { type: 'button', 'data-sm-focusable': '', style: styles.button, disabled: busy, onClick: () => { setRemoving(null); setRemoveFiles(false) } }, '取消'),
                h('button', { type: 'button', 'data-sm-focusable': '', style: styles.buttonDanger, disabled: busy, onClick: confirmRemove }, busy ? '移除中…' : '移除'),
              ),
            ),
          )
          : null,
      )
    }

    const SIDEBAR_CSS = [
      '[data-row-key^="workspace:"]{position:relative}',
      '[data-sm-colour-bar]{position:absolute;left:2px;top:5px;bottom:5px;width:3px;border-radius:2px;pointer-events:none;opacity:0.9}',
    ].join('')

    /** Paints each Super Agent workspace folder with its configured colour. */
    function startWorkspaceColours() {
      const state = { colors: new Map(), observer: null, timer: 0 }
      let style = null
      try {
        style = document.createElement('style')
        style.setAttribute('data-sm-colour-style', '')
        style.textContent = SIDEBAR_CSS
        ;(document.head || document.body).appendChild(style)
      } catch (cause) {
        console.warn('[dsh-superagent-manager] workspace colour css failed', cause)
      }

      const paint = () => {
        try {
          const rows = document.querySelectorAll('[data-row-key^="workspace:"]')
          for (const row of rows) {
            const id = String(row.getAttribute('data-row-key') || '').slice('workspace:'.length)
            const color = state.colors.get(id)
            if (!color) continue
            let bar = row.querySelector('[data-sm-colour-bar]')
            if (!bar) {
              bar = document.createElement('span')
              bar.setAttribute('data-sm-colour-bar', '')
              row.appendChild(bar)
            }
            bar.style.background = color
            const folder = row.querySelector('[class*="folder"]')
            if (folder) {
              folder.style.color = color
              folder.style.opacity = '1'
            }
          }
        } catch (cause) {
          // A half-painted sidebar is acceptable; a thrown paint is not.
          console.warn('[dsh-superagent-manager] workspace colour paint failed', cause)
        }
      }

      const refresh = async () => {
        try {
          const data = await apiFetch(LIST_PATH, { timeoutMs: 20000 })
          const next = new Map()
          for (const instance of (data.instances || [])) {
            if (!instance.color) continue
            const ids = Array.isArray(instance.workspaces) && instance.workspaces.length
              ? instance.workspaces
              : (instance.workspaceId ? [instance.workspaceId] : [])
            for (const id of ids) next.set(id, instance.color)
          }
          state.colors = next
          paint()
        } catch {
          // The panel is the primary surface; the sidebar mark is a bonus.
        }
      }

      const schedule = () => {
        if (state.timer) return
        state.timer = window.setTimeout(() => { state.timer = 0; paint() }, 120)
      }

      refresh()
      try {
        state.observer = new MutationObserver(schedule)
        const attach = () => {
          if (!document.body) { window.setTimeout(attach, 500); return }
          state.observer.observe(document.body, { childList: true, subtree: true })
          paint()
        }
        attach()
      } catch (cause) {
        console.warn('[dsh-superagent-manager] workspace colour observer failed', cause)
      }
      const onColour = () => { refresh() }
      window.addEventListener(COLOR_EVENT, onColour)
      const interval = window.setInterval(refresh, 60000)
      return () => {
        if (state.observer) state.observer.disconnect()
        if (state.timer) window.clearTimeout(state.timer)
        window.clearInterval(interval)
        window.removeEventListener(COLOR_EVENT, onColour)
        try {
          document.querySelectorAll('[data-sm-colour-bar]').forEach((node) => node.remove())
          if (style) style.remove()
        } catch { /* the shell is already gone */ }
      }
    }


    const STAGE_ID = 'dsh-superagent-manager-stage'
    const STAGE_ORDER = 12

    const stageStyles = {
      wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: '10px', padding: '14px 18px 0' },
      head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
      tab: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 10px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.28)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
      tabOn: { background: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.55)' },
      tabGroup: { display: 'inline-flex', alignItems: 'center', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.28)', overflow: 'hidden' },
      tabGroupOn: { display: 'inline-flex', alignItems: 'center', borderRadius: '8px', border: '1px solid rgba(91,141,239,0.55)', background: 'rgba(91,141,239,0.14)', overflow: 'hidden' },
      tabLabel: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 4px 5px 10px', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
      switchWrap: { display: 'inline-flex', alignItems: 'center', padding: '0 7px 0 3px' },
      switchTrack: { position: 'relative', width: '26px', height: '15px', padding: 0, border: 0, borderRadius: '999px', background: 'rgba(128,128,128,0.35)', cursor: 'pointer', transition: 'background 120ms ease' },
      switchTrackOn: { background: '#2fbf71' },
      switchKnob: { position: 'absolute', top: '2px', left: '2px', width: '11px', height: '11px', borderRadius: '50%', background: '#fff', transition: 'left 120ms ease' },
      switchKnobOn: { left: '13px' },
      box: { flex: '1 1 auto', minHeight: 0, marginBottom: '14px', border: '1px solid rgba(128,128,128,0.22)', borderRadius: '10px', overflow: 'hidden', position: 'relative' },
      hint: { padding: '28px', fontSize: '13px', lineHeight: 1.7, opacity: 0.75 },
    }

    function StageIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M13 2 4.5 13.5H11l-2 8.5 8.5-11.5H11z' }),
      )
    }

    // Every embedded client keeps its "current session", open tabs and drafts in
    // origin-scoped localStorage. Sharing the host origin therefore pointed the panel at a
    // session that belongs to the outer client, and it opened on "pick a workspace" instead
    // of the agent's own conversation. `<id>.localhost` isolates storage but the desktop
    // shell does not resolve those names, so each instance gets a loopback port of its own:
    // a distinct origin the shell always loads. The shared /sa proxy stays as the fallback
    // for profiles whose manager could not bind a port.
    const ISOLATED_PANEL_ORIGIN = false

    function instanceOrigin(id) {
      const label = String(id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
      if (!label) return ''
      const port = window.location.port ? ':' + window.location.port : ''
      return 'http://' + label + '.localhost' + port
    }

    function panelOrigin(id) {
      if (ISOLATED_PANEL_ORIGIN) return instanceOrigin(id)
      const host = window.location.origin
      // file:// pages report the opaque origin "null"; fall back to the sub-origin there.
      return host && host !== 'null' ? host : instanceOrigin(id)
    }

    function instanceFrameUrl(item) {
      if (!item || !item.id) return ''
      if (item.proxyPort) return 'http://127.0.0.1:' + item.proxyPort + '/'
      return panelOrigin(item.id) + '/sa/' + encodeURIComponent(item.id) + '/'
    }

    // --- Long-lived instance panels ------------------------------------------------
    //
    // This page is one slot entry among many: opening a conversation, settings or another
    // panel replaces the entry, React unmounts the component, and an iframe rendered from
    // JSX dies with it. Every comeback then booted three embedded clients again, which is
    // the "click it and wait" behaviour this layer removes.
    //
    // So the frames live outside the React tree, in a fixed layer that follows the stage
    // box. React decides which frames exist, which one is visible, and when one reloads;
    // it never owns their lifetime. Unmounting only hides the layer, and the only thing
    // that reloads a frame is the 刷新 button (or the src of an instance changing).

    const frameLayer = { el: null, frames: new Map() }

    // Timestamp of the last automatic workspace sync. Module scope on purpose: leaving the
    // page and coming back remounts the component, and the throttle has to survive that.
    let lastAutoSyncAt = 0

    function layerElement() {
      if (frameLayer.el && frameLayer.el.isConnected) return frameLayer.el
      const el = document.createElement('div')
      el.setAttribute('data-dsm-frames', '')
      // Sits above the stage box but below the shell's own overlays; sized by placeLayer().
      el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;z-index:20;'
      document.body.appendChild(el)
      frameLayer.el = el
      // Nodes of a discarded layer are gone with it, so the bookkeeping restarts empty.
      frameLayer.frames.clear()
      return el
    }

    function makeFrame(item, url) {
      const el = document.createElement('iframe')
      el.title = item.name || item.id
      el.setAttribute('allow', 'clipboard-read; clipboard-write')
      // The shell serves this page from dsh-app://app, so the frame is cross-site by
      // construction. An origin-level referrer is what the proxy uses to tell the shell
      // apart from a website embedding us.
      el.setAttribute('referrerpolicy', 'origin')
      el.style.cssText = 'display:none;width:100%;height:100%;border:0;background:#fff;'
      el.src = url
      return el
    }

    function frameFor(item) {
      const layer = layerElement()
      const url = instanceFrameUrl(item)
      let frame = frameLayer.frames.get(item.id)
      if (!frame) {
        const el = makeFrame(item, url)
        layer.appendChild(el)
        frame = { el, url }
        frameLayer.frames.set(item.id, frame)
      } else if (url && frame.url !== url) {
        // Only a real address change (a new proxy port) navigates an existing frame.
        frame.url = url
        frame.el.src = url
      }
      return frame
    }

    function dropFrame(id) {
      const frame = frameLayer.frames.get(id)
      if (!frame) return
      frameLayer.frames.delete(id)
      if (frame.el.parentNode) frame.el.parentNode.removeChild(frame.el)
    }

    /** The one thing that rebuilds a document: replace the node, keep its visibility. */
    function reloadFrame(id) {
      const frame = frameLayer.frames.get(id)
      if (!frame || !frame.el.parentNode) return
      const el = makeFrame({ id, name: frame.el.title }, frame.url)
      el.style.display = frame.el.style.display
      frame.el.parentNode.replaceChild(el, frame.el)
      frame.el = el
    }

    /** Reconcile the layer with the registry: create missing frames, hide the rest. */
    function syncFrames(instances, activeId, visible) {
      const live = new Set()
      for (const item of instances) {
        if (!item.running || !item.url) continue
        live.add(item.id)
        frameFor(item)
      }
      for (const id of [...frameLayer.frames.keys()]) if (!live.has(id)) dropFrame(id)
      const layer = frameLayer.el
      if (!layer) return
      layer.style.display = visible ? 'block' : 'none'
      layer.style.pointerEvents = visible ? 'auto' : 'none'
      for (const [id, frame] of frameLayer.frames) {
        frame.el.style.display = visible && id === activeId ? 'block' : 'none'
      }
    }

    /** Keep the layer exactly over the stage box while the shell resizes or reflows. */
    function placeLayer(box) {
      const layer = frameLayer.el
      if (!layer || !box) return
      const rect = box.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      layer.style.left = Math.round(rect.left) + 'px'
      layer.style.top = Math.round(rect.top) + 'px'
      layer.style.width = Math.round(rect.width) + 'px'
      layer.style.height = Math.round(rect.height) + 'px'
    }

  function StagePanel() {
      const [data, setData] = React.useState(null)
      const [active, setActive] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // Instance id whose start/stop switch is mid-flight, so the switch can't be
      // double-toggled while the backend process is coming up or shutting down.
      const [toggling, setToggling] = React.useState(null)
      const [syncing, setSyncing] = React.useState(false)
      // Last sync outcome, shown on the button for a few seconds and then cleared.
      const [syncNote, setSyncNote] = React.useState('')
      const boxRef = React.useRef(null)
      // A ref, not state: the latch must be closed synchronously or two mounts in the same
      // tick both fire the sync before either sees `syncing`.
      const syncLatch = React.useRef(false)

      const bump = React.useCallback((id) => {
        // Reloads one panel only; the others keep their scroll position and drafts.
        reloadFrame(id)
      }, [])

      const load = React.useCallback(async () => {
        try {
          const payload = await apiFetch(LIST_PATH)
          setData(payload)
          setError(null)
          setActive((prev) => {
            const list = (payload && payload.instances) || []
            if (prev && list.some((item) => item.id === prev)) return prev
            const running = list.find((item) => item.running && item.url)
            return running ? running.id : list.length ? list[0].id : null
          })
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) load() }
        tick()
        const timer = window.setInterval(tick, 30000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [load])

      React.useEffect(() => {
        // The settings page can create / stop / remove instances while this panel is
        // open; re-read on those mutations so tabs and switches never disagree.
        const onChange = () => { void load() }
        window.addEventListener(INSTANCES_EVENT, onChange)
        return () => window.removeEventListener(INSTANCES_EVENT, onChange)
      }, [load])

      // No automatic reload: the panels are long-lived on purpose, so coming back to this
      // page never costs a full client boot. A stale panel is refreshed with the 刷新
      // button, which is the only thing that remounts a frame.

      const start = React.useCallback(async (id) => {
        setBusy(true)
        try {
          await apiFetch(START_PATH, { method: 'POST', body: { id }, timeoutMs: 180000 })
          await load()
          notifyInstancesChanged()
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [load])

      // Manual on/off switch on a tab: unlike opening the tab (which only mounts the
      // embedded UI), this actually starts or stops the instance process, and the
      // settings page reflects it because both read the same registry.
      const toggle = React.useCallback(async (item) => {
        if (!item || toggling) return
        setToggling(item.id)
        setError(null)
        const stopping = Boolean(item.running)
        try {
          await apiFetch(stopping ? STOP_PATH : START_PATH, {
            method: 'POST',
            body: { id: item.id },
            timeoutMs: stopping ? 40000 : 180000,
          })
          await load()
          notifyInstancesChanged()
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        } finally {
          setToggling(null)
        }
      }, [load, toggling])

      // A conversation created inside a tab belongs to that instance's process. Its file
      // is on disk at once, but the workspace account — the only thing the sidebar and
      // every other view read — never hears about it. This is the repair action: the host
      // walks the instance's session files and attaches the ones the workspace is missing.
      const syncSessions = React.useCallback(async (options) => {
        const opts = options || {}
        if (syncLatch.current) return
        syncLatch.current = true
        setSyncing(true)
        try {
          const payload = await apiFetch(SYNC_PATH, {
            method: 'POST',
            body: opts.id ? { id: opts.id } : {},
            timeoutMs: 60000,
          })
          const count = Number(payload && payload.attached) || 0
          const failed = ((payload && payload.results) || []).filter((item) => item && item.ok === false)
          if (failed.length) {
            setError(failed.map((item) => (item.name || item.id) + '：' + (item.error || '同步失败')).join('；'))
          } else if (!opts.quiet) {
            setError(null)
          }
          if (!opts.quiet || count) setSyncNote(count ? '已登记 ' + count + ' 条' : '没有新会话')
          await load()
        } catch (cause) {
          if (!opts.quiet) setError(cause && cause.message ? cause.message : String(cause))
        } finally {
          syncLatch.current = false
          setSyncing(false)
        }
      }, [load])

      React.useEffect(() => {
        // Opening the panel is the moment stale visibility would be noticed, so pull once
        // on mount. Throttled: every attach rewrites the registry file, and a remount after
        // switching pages must not do that again.
        if (Date.now() - lastAutoSyncAt < 60000) return
        lastAutoSyncAt = Date.now()
        void syncSessions({ quiet: true })
      }, [syncSessions])

      React.useEffect(() => {
        if (!syncNote) return
        const timer = window.setTimeout(() => setSyncNote(''), 4000)
        return () => window.clearTimeout(timer)
      }, [syncNote])

      const instances = (data && data.instances) || []
      const current = instances.find((item) => item.id === active) || null
      const tabs = instances.map((item) => {
        const running = Boolean(item.running)
        const pending = toggling === item.id
        return h('div', {
          key: 'tab-' + item.id,
          style: item.id === active ? stageStyles.tabGroupOn : stageStyles.tabGroup,
        },
          h('button', {
            type: 'button',
            style: stageStyles.tabLabel,
            onClick: () => setActive(item.id),
            title: running ? '端口 ' + item.port : '已停止',
          },
            h('span', { key: 'dot', style: Object.assign({}, styles.dot, { background: item.color || '#8a94a6' }) }),
            h('span', { key: 'name' }, item.name || item.id),
            pending
              ? h('span', { key: 'state', style: { opacity: 0.55 } }, running ? '停止中…' : '启动中…')
              : running ? null : h('span', { key: 'state', style: { opacity: 0.55 } }, '已停止'),
          ),
          h('span', { key: 'switch', style: stageStyles.switchWrap },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': running ? 'true' : 'false',
              'aria-label': (running ? '停用 ' : '启用 ') + (item.name || item.id),
              title: running ? '停用：停止这个实例（设置页同步）' : '启用：启动这个实例（设置页同步）',
              disabled: pending,
              style: Object.assign({}, stageStyles.switchTrack, running ? stageStyles.switchTrackOn : null, pending ? { opacity: 0.55, cursor: 'default' } : null),
              onClick: (event) => { event.stopPropagation(); void toggle(item) },
            },
              h('span', {
                style: Object.assign({}, stageStyles.switchKnob, running ? stageStyles.switchKnobOn : null),
              }),
            ),
          ),
        )
      })

      // Every running instance has a frame from the first render on, and that frame
      // outlives this component: leaving the page hides the layer instead of destroying
      // three embedded clients, so coming back is instant. Only 刷新 (or a changed
      // instance address) reloads one.
      const panelsVisible = Boolean(current && current.running && current.url)

      React.useLayoutEffect(() => {
        // A remount starts with no list yet; reconciling against `[]` would throw away
        // every frame that is still sitting in the layer, which is exactly the reboot
        // this design avoids. An empty *answer* from the server still prunes.
        if (!data) return
        syncFrames(instances, active, panelsVisible)
      }, [data, instances, active, panelsVisible])

      React.useLayoutEffect(() => {
        const place = () => { if (!document.hidden) placeLayer(boxRef.current) }
        place()
        // The shell reflows on sidebar collapse, window resize and title-bar changes
        // without emitting anything the stage hears about, so poll cheaply and correct.
        const timer = window.setInterval(place, 250)
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        let observer = null
        if (typeof ResizeObserver === 'function' && boxRef.current) {
          observer = new ResizeObserver(place)
          observer.observe(boxRef.current)
        }
        return () => {
          window.clearInterval(timer)
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          if (observer) observer.disconnect()
          // Frames stay alive for the next visit; only the layer goes out of sight.
          if (frameLayer.el) frameLayer.el.style.display = 'none'
        }
      }, [])

      let body = null
      if (!instances.length) {
        body = h('div', { key: 'empty', style: stageStyles.hint }, '还没有 Super Agent 项目。到设置 → Super Agent 管理里新建一个项目，它就会出现在这里。')
      } else if (current && !current.running) {
        body = h('div', { key: 'stopped', style: stageStyles.hint },
          '「' + (current.name || current.id) + '」当前没有在运行。',
          h('div', { key: 'act', style: { marginTop: '10px' } },
            h('button', {
              type: 'button',
              style: styles.button || stageStyles.tab,
              disabled: busy,
              onClick: () => start(current.id),
            }, busy ? '正在启动…' : '启动它'),
          ),
        )
      } else if (!current) {
        body = h('div', { key: 'none', style: stageStyles.hint }, '选一个项目。')
      }

      return h('div', { style: stageStyles.wrap },
        h('div', { style: stageStyles.head },
          h('div', { key: 'tabs', style: stageStyles.tabs }, tabs),
          h('button', {
            key: 'refresh',
            type: 'button',
            style: stageStyles.tab,
            'data-sm-focusable': '',
            title: '只重新加载当前项目的界面（登录失效时用这个）',
            onClick: () => { bump(active); void load() },
          }, '刷新' + (current ? '「' + (current.name || current.id) + '」' : '')),
          h('button', {
            key: 'sync',
            type: 'button',
            style: Object.assign({}, stageStyles.tab, syncing ? { opacity: 0.55, cursor: 'default' } : null),
            'data-sm-focusable': '',
            disabled: syncing,
            title: '把实例里新建的会话登记进它的工作区，这样侧边栏和其他页面也能看到（可反复点，重复的会跳过）',
            onClick: () => void syncSessions({}),
          }, syncing ? '同步中…' : (syncNote || '同步会话')),
          current
            ? h('button', {
              key: 'toggle',
              type: 'button',
              style: Object.assign({}, stageStyles.tab, toggling ? { opacity: 0.55, cursor: 'default' } : null),
              disabled: Boolean(toggling),
              title: current.running ? '停止这个实例，设置页同步显示为已停止' : '启动这个实例，设置页同步显示为运行中',
              onClick: () => void toggle(current),
            }, current.running ? '停用' : '启用')
            : null,
          current && current.url
            ? h('a', {
              key: 'open',
              href: current.url,
              target: '_blank',
              rel: 'noreferrer',
              style: Object.assign({}, stageStyles.tab, { textDecoration: 'none' }),
              title: '在新标签页里打开这个项目的完整界面',
            }, '新标签页打开')
            : null,
        ),
        error ? h('div', { style: styles.error }, error) : null,
        // The frames are painted into the layer above this box; the box only reserves
        // the space they are measured against.
        h('div', { ref: boxRef, style: stageStyles.box }, body),
      )
    }

    function installStage(ctx) {
      const disposers = []
      const done = { main: false, sidebar: false }
      let timer = null
      let tries = 0

      const tryRegister = (name, factory) => {
        try {
          if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(name) === undefined) return false
          disposers.push(factory())
          return true
        } catch (cause) {
          const message = cause && typeof cause.message === 'string' ? cause.message : ''
          if (message.includes('already has an entry')) return true
          return false
        }
      }

      const stop = () => {
        if (timer) { window.clearInterval(timer); timer = null }
      }

      const attempt = () => {
        if (!done.main && tryRegister('main', () => ctx.slots.register({ name: 'main', key: STAGE_ID, locale: NS, inject: () => ({}) }, StagePanel))) done.main = true
        if (!done.sidebar && tryRegister('sidebar', () => ctx.slots.register({ name: 'sidebar.panellist', id: STAGE_ID, order: STAGE_ORDER, label: () => 'Super Agent', locale: NS }, StageIcon))) done.sidebar = true
        if (done.main && done.sidebar) stop()
      }

      attempt()
      if (!(done.main && done.sidebar)) {
        timer = window.setInterval(() => {
          tries += 1
          attempt()
          if (tries > 20) stop()
        }, 500)
      }

      return () => {
        stop()
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* already gone */ }
        }
      }
    }

    function installSection(ctx, label) {
      let dispose
      let mounted = false
      const mount = () => {
        if (mounted || !ctx.slots) return
        try {
          if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(SETTINGS_SECTION) === undefined) return
          dispose = ctx.slots.register({
            name: SETTINGS_SECTION,
            id: SECTION_ID,
            order: SECTION_ORDER,
            label,
            locale: NS,
            inject: () => ({}),
          }, SuperAgentManagerPanel)
          mounted = true
        } catch (cause) {
          const message = cause && typeof cause.message === 'string' ? cause.message : ''
          if (message.includes('already has an entry with id')) {
            mounted = true
            return
          }
          console.warn('[dsh-superagent-manager] section mount failed', cause)
        }
      }
      mount()
      if (!mounted && typeof ctx.on === 'function') {
        try {
          ctx.on('slots/changed', () => { if (!mounted) mount() })
        } catch {
          // Without the change feed the first attempt is all we get.
        }
      }
      return () => {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch {
            // Already disposed.
          }
        }
        mounted = false
      }
    }

    // ---- read-only mirror -----------------------------------------------------
    // A Super Agent conversation belongs to the instance process that runs it. This
    // panel only *reads* its session log and paints it. There is deliberately no
    // composer here: no input, no send, no approval buttons — those stay in the instance.
    const MIRROR_ID = 'dsh-superagent-mirror'
    const MIRROR_ORDER = STAGE_ORDER + 1
    const MIRROR_LIST_PATH = 'api/dsh-superagent-manager/mirror/list'
    const MIRROR_SESSION_PATH = 'api/dsh-superagent-manager/mirror/session'
    const MIRROR_POLL_MS = 2000
    const MIRROR_LIST_MS = 8000

    const mirrorStyles = {
      root: {
        display: 'flex',
        alignItems: 'stretch',
        height: '100%',
        minHeight: 0,
        font: '13px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif',
        color: 'inherit',
      },
      rail: {
        width: '244px',
        flex: '0 0 auto',
        overflowY: 'auto',
        padding: '12px 8px 20px',
        borderRight: '1px solid rgba(128,128,128,0.22)',
      },
      group: { padding: '10px 8px 2px', fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.55 },
      sessionRow: {
        padding: '6px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      main: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' },
      head: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 16px',
        borderBottom: '1px solid rgba(128,128,128,0.22)',
      },
      title: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: '11px',
        padding: '1px 7px',
        borderRadius: '999px',
        border: '1px solid rgba(128,128,128,0.4)',
        opacity: 0.8,
        whiteSpace: 'nowrap',
      },
      timeline: { flex: '1 1 auto', overflowY: 'auto', padding: '14px 18px 28px' },
      block: { marginBottom: '12px' },
      label: { fontSize: '11px', opacity: 0.55, marginBottom: '2px' },
      bubble: { background: 'rgba(127,127,127,0.10)', borderRadius: '8px', padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      plain: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.85 },
      toolRow: { display: 'flex', alignItems: 'baseline', gap: '6px', opacity: 0.85 },
      warn: { borderLeft: '3px solid #D9A400', background: 'rgba(217,164,0,0.12)', padding: '6px 10px', borderRadius: '4px' },
      err: { borderLeft: '3px solid #D14343', background: 'rgba(209,67,67,0.10)', padding: '6px 10px', borderRadius: '4px' },
      note: { fontSize: '12px', opacity: 0.6, fontStyle: 'italic' },
      foot: { flex: '0 0 auto', padding: '6px 16px', fontSize: '11px', opacity: 0.6, borderTop: '1px solid rgba(128,128,128,0.18)' },
      empty: { padding: '40px 24px', textAlign: 'center', opacity: 0.6 },
    }

    function mirrorTime(value) {
      if (!value) return ''
      const date = new Date(value)
      const diff = Date.now() - value
      if (diff >= 0 && diff < 60000) return '刚刚'
      if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      const sameDay = new Date().toDateString() === date.toDateString()
      return sameDay
        ? pad(date.getHours()) + ':' + pad(date.getMinutes())
        : (date.getMonth() + 1) + '/' + date.getDate() + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function mirrorItem(item, index) {
      const key = 'i' + index
      const at = item.at ? mirrorTime(item.at) : ''
      if (item.k === 'user') {
        return h('div', { key, style: mirrorStyles.block },
          h('div', { style: mirrorStyles.label }, '你' + (at ? ' · ' + at : '')),
          h('div', { style: mirrorStyles.bubble }, item.text),
        )
      }
      if (item.k === 'text') {
        return h('div', { key, style: mirrorStyles.block },
          h('div', { style: mirrorStyles.label }, '助手' + (at ? ' · ' + at : '')),
          h('div', { style: mirrorStyles.plain }, item.text),
        )
      }
      if (item.k === 'reason') {
        return h('details', { key, style: mirrorStyles.block },
          h('summary', { style: mirrorStyles.note }, '思考过程' + (at ? ' · ' + at : '')),
          h('div', { style: Object.assign({}, mirrorStyles.plain, { opacity: 0.7, marginTop: '4px', whiteSpace: 'pre-wrap' }) }, item.text),
        )
      }
      if (item.k === 'tool') {
        return h('details', { key, style: mirrorStyles.block },
          h('summary', { style: mirrorStyles.toolRow },
            h('span', { style: mirrorStyles.mono }, '▸ ' + item.name),
            h('span', { style: mirrorStyles.note }, at),
          ),
          h('div', { style: Object.assign({}, mirrorStyles.mono, { marginTop: '4px' }) }, item.args),
        )
      }
      if (item.k === 'result') {
        return h('details', { key, style: mirrorStyles.block },
          h('summary', { style: item.isError ? mirrorStyles.err : mirrorStyles.note },
            (item.isError ? '工具报错' : '工具结果') + (at ? ' · ' + at : '')),
          h('div', { style: Object.assign({}, mirrorStyles.mono, { marginTop: '4px' }) }, item.text || '（空）'),
        )
      }
      if (item.k === 'approval') {
        return h('div', { key, style: Object.assign({}, mirrorStyles.block, mirrorStyles.warn) },
          h('div', { style: { fontWeight: 600 } }, '等待审批：' + (item.tool || '工具')),
          h('div', { style: mirrorStyles.note }, '这是只读镜像，审批请在实例里完成'),
          item.reason ? h('div', { style: Object.assign({}, mirrorStyles.plain, { marginTop: '4px', fontSize: '12px' }) }, item.reason) : null,
        )
      }
      if (item.k === 'approval-done') {
        return h('div', { key, style: Object.assign({}, mirrorStyles.block, mirrorStyles.note) }, '审批已处理' + (at ? ' · ' + at : ''))
      }
      if (item.k === 'todo') {
        const todos = Array.isArray(item.todos) ? item.todos : []
        return h('div', { key, style: mirrorStyles.block },
          h('div', { style: mirrorStyles.label }, '待办'),
          h('div', {}, todos.map((todo, i) => h('div', {
            key: 't' + i,
            style: { opacity: todo.status === 'completed' ? 0.5 : 0.9 },
          }, (todo.status === 'completed' ? '✓ ' : todo.status === 'in_progress' ? '▸ ' : '· ') + todo.content))),
        )
      }
      if (item.k === 'note') {
        return h('div', { key, style: Object.assign({}, mirrorStyles.block, mirrorStyles.note) }, item.text)
      }
      return null
    }

    function MirrorPanel() {
      const [list, setList] = React.useState({ status: 'loading', instances: [] })
      const [selected, setSelected] = React.useState(null)
      const [session, setSession] = React.useState({ status: 'idle', items: [], key: '' })
      const scroller = React.useRef(null)
      const stickToBottom = React.useRef(true)

      React.useEffect(() => {
        let alive = true
        const load = () => {
          apiFetch(MIRROR_LIST_PATH, { timeoutMs: 15000 })
            .then((payload) => { if (alive) setList({ status: 'ready', instances: (payload && payload.instances) || [] }) })
            .catch((error) => { if (alive) setList({ status: 'error', instances: [], error: String(error.message || error) }) })
        }
        load()
        const timer = window.setInterval(load, MIRROR_LIST_MS)
        return () => { alive = false; window.clearInterval(timer) }
      }, [])

      const selectionKey = selected ? selected.instance + '::' + selected.session : ''

      React.useEffect(() => {
        if (!selectionKey) { setSession({ status: 'idle', items: [], key: '' }); return undefined }
        let alive = true
        // Switching conversations drops the old timeline immediately. Leaving it in
        // place while the new request was in flight showed the previous conversation
        // under the new title, and a slow reply could then overwrite the newer choice.
        setSession((current) => ({
          status: 'loading',
          items: [],
          key: selectionKey,
          meta: current.key === selectionKey ? current.meta : null,
          at: current.key === selectionKey ? current.at : 0,
        }))
        const load = () => {
          const path = MIRROR_SESSION_PATH
            + '?instance=' + encodeURIComponent(selected.instance)
            + '&session=' + encodeURIComponent(selected.session)
            + '&limit=300'
          apiFetch(path, { timeoutMs: 20000 })
            .then((payload) => {
              if (!alive) return
              setSession({ status: 'ready', items: (payload && payload.items) || [], meta: payload, key: selectionKey, at: Date.now() })
            })
            .catch((error) => {
              if (!alive) return
              // Keep what was already read and mark it stale instead of blanking the
              // window on a transient poll failure.
              setSession((current) => (current.key === selectionKey
                ? { ...current, status: 'error', error: String(error.message || error) }
                : { status: 'error', items: [], error: String(error.message || error), key: selectionKey }))
            })
        }
        load()
        const timer = window.setInterval(load, MIRROR_POLL_MS)
        return () => { alive = false; window.clearInterval(timer) }
      }, [selectionKey])

      React.useEffect(() => {
        const node = scroller.current
        if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
      }, [session.items])

      const onScroll = () => {
        const node = scroller.current
        if (!node) return
        stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
      }

      const current = selected
        ? (list.instances.find((item) => item.id === selected.instance) || null)
        : null

      const rail = h('div', { style: mirrorStyles.rail },
        h('div', { style: Object.assign({}, mirrorStyles.group, { textTransform: 'none', fontSize: '12px', opacity: 0.75 }) },
          '实例对话（只读）'),
        list.status === 'loading' ? h('div', { style: mirrorStyles.note }, '读取中…') : null,
        list.status === 'error' ? h('div', { style: mirrorStyles.err }, list.error) : null,
        list.instances.length === 0 && list.status === 'ready'
          ? h('div', { style: mirrorStyles.note }, '还没有实例')
          : null,
        list.instances.map((instance) => h('div', { key: instance.id, style: { marginBottom: '10px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: instance.color || '#7A8CA0', flex: '0 0 auto' } }),
            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, instance.name || instance.id),
          ),
          instance.sessions.length === 0
            ? h('div', { style: Object.assign({}, mirrorStyles.note, { padding: '0 8px' }) }, '还没有对话')
            : instance.sessions.map((item) => {
              const active = selected && selected.instance === instance.id && selected.session === item.id
              return h('button', {
                key: item.id,
                type: 'button',
                onClick: () => { stickToBottom.current = true; setSelected({ instance: instance.id, session: item.id }) },
                style: Object.assign({}, mirrorStyles.sessionRow, active ? { background: 'rgba(127,127,127,0.16)' } : null),
                title: item.id,
              },
              h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
              h('div', { style: { fontSize: '11px', opacity: 0.55 } }, mirrorTime(item.updatedAt)),
              )
            }),
        )),
      )

      if (!selected) {
        return h('div', { style: mirrorStyles.root },
          rail,
          h('div', { style: mirrorStyles.main },
            h('div', { style: Object.assign({}, mirrorStyles.empty) },
              h('div', { style: { fontSize: '15px', marginBottom: '6px' } }, '选择一个对话查看镜像'),
              h('div', { style: mirrorStyles.note }, '这里只读：能看到消息与工具调用，不能输入。要接着聊请到实例里。'),
            ),
          ),
        )
      }

      const meta = session.meta || null
      const switching = session.status === 'loading'
      const stale = session.status === 'error' && session.items.length > 0
      return h('div', { style: mirrorStyles.root },
        rail,
        h('div', { style: mirrorStyles.main },
          h('div', { style: mirrorStyles.head },
            h('div', { style: mirrorStyles.title }, (meta && meta.title) || (current ? current.name : '') || '对话'),
            h('span', { style: mirrorStyles.badge }, '只读镜像'),
            switching
              ? h('span', { style: Object.assign({}, mirrorStyles.badge, { opacity: 0.7 }) }, '正在切换…')
              : null,
            stale
              ? h('span', { style: Object.assign({}, mirrorStyles.badge, { borderColor: '#D9A400', opacity: 0.9 }) }, '连接中断 · 旧数据')
              : null,
            meta && typeof meta.total === 'number'
              ? h('span', { style: Object.assign({}, mirrorStyles.badge, { opacity: 0.55 }) }, '最近 ' + session.items.length + ' / 共 ' + meta.total + ' 条')
              : null,
            h('span', { style: { flex: '1 1 auto' } }),
            // "Open in the instance" starts at the instance's own last session, so it
            // cannot deep-link to the conversation being read here.
            current && current.url
              ? h('a', {
                href: current.url,
                target: '_blank',
                rel: 'noreferrer',
                style: { fontSize: '12px', color: '#4B6BFB', textDecoration: 'none' },
                title: '在实例里继续：实例会打开它自己的当前会话，不一定就是这一个',
              }, '在实例中打开')
              : null,
          ),
          h('div', { ref: scroller, onScroll, style: mirrorStyles.timeline },
            switching ? h('div', { style: mirrorStyles.note }, '读取中…') : null,
            session.status === 'error' && session.items.length === 0
              ? h('div', { style: mirrorStyles.err }, session.error)
              : null,
            stale ? h('div', { style: Object.assign({}, mirrorStyles.warn, { marginBottom: '10px' }) }, '刷新失败：' + session.error) : null,
            session.status === 'ready' && session.items.length === 0
              ? h('div', { style: mirrorStyles.empty }, '这个对话还没有内容')
              : session.items.map(mirrorItem),
          ),
          h('div', { style: mirrorStyles.foot },
            '只读镜像：数据来自实例的会话日志，输入请到实例中进行。',
            session.at ? ' · 最后更新 ' + mirrorTime(session.at) : '',
            session.status === 'error' ? ' · 未连接到实例' : '',
          ),
        ),
      )
    }

    function MirrorIcon({ size }) {
      const box = typeof size === 'number' ? size : 18
      return h('svg', {
        width: box,
        height: box,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2.5 }),
      h('path', { d: 'M7 9h7M7 12.5h4.5' }),
      h('path', { d: 'M9 20h6' }),
      )
    }

    function installMirror(ctx) {
      const disposers = []
      const done = { main: false, sidebar: false }
      let timer = null
      let tries = 0

      const tryRegister = (name, factory) => {
        try {
          if (typeof ctx.slots.spec === 'function' && ctx.slots.spec(name) === undefined) return false
          disposers.push(factory())
          return true
        } catch (cause) {
          const message = cause && typeof cause.message === 'string' ? cause.message : ''
          if (message.includes('already has an entry')) return true
          return false
        }
      }

      const stop = () => {
        if (timer) { window.clearInterval(timer); timer = null }
      }

      const attempt = () => {
        if (!done.main && tryRegister('main', () => ctx.slots.register({ name: 'main', key: MIRROR_ID, locale: NS, inject: () => ({}) }, MirrorPanel))) done.main = true
        if (!done.sidebar && tryRegister('sidebar', () => ctx.slots.register({ name: 'sidebar.panellist', id: MIRROR_ID, order: MIRROR_ORDER, label: () => '对话镜像', locale: NS }, MirrorIcon))) done.sidebar = true
        if (done.main && done.sidebar) stop()
      }

      attempt()
      if (!(done.main && done.sidebar)) {
        timer = window.setInterval(() => {
          tries += 1
          attempt()
          if (tries > 20) stop()
        }, 500)
      }

      return () => {
        stop()
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* already gone */ }
        }
      }
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
        try {
          ctx.locale.register(NS, dictionaries)
        } catch {
          // A locale host that refuses the dictionary still gets a literal label.
        }
      }
      const label = () => {
        try {
          const translate = ctx.locale.bind(NS)
          const value = translate('title')
          const literal = typeof value === 'string' && value !== '' && value !== 'title' && value.indexOf(NS) !== 0
          return literal ? value : 'Super Agent 管理'
        } catch {
          return 'Super Agent 管理'
        }
      }
      const dispose = installSection(ctx, label)
      let stopColours = () => {}
      try {
        if (typeof document !== 'undefined') stopColours = startWorkspaceColours()
      } catch (cause) {
        console.warn('[dsh-superagent-manager] workspace colouring failed', cause)
      }
      let stopStage = () => {}
      try {
        stopStage = installStage(ctx)
      } catch (cause) {
        console.warn('[dsh-superagent-manager] stage install failed', cause)
      }
      let stopMirror = () => {}
      try {
        stopMirror = installMirror(ctx)
      } catch (cause) {
        console.warn('[dsh-superagent-manager] mirror install failed', cause)
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try {
            stopMirror()
          } catch {
            // Mirror panel already gone.
          }
          try {
            stopStage()
          } catch {
            // Panel already gone.
          }
          try {
            dispose()
          } catch {
            // Section already gone.
          }
          try {
            stopColours()
          } catch {
            // Already removed.
          }
        }, 'dsh-superagent-manager: settings section')
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
