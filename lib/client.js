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
    const CREATE_PATH = 'api/dsh-superagent-manager/create'
    const START_PATH = 'api/dsh-superagent-manager/start'
    const STOP_PATH = 'api/dsh-superagent-manager/stop'
    const REMOVE_PATH = 'api/dsh-superagent-manager/remove'

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
      switchRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
      button: { height: '32px', padding: '0 14px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px', cursor: 'pointer' },
      buttonPrimary: { height: '32px', padding: '0 16px', borderRadius: '8px', border: '1px solid transparent', background: '#4b6bfb', color: '#fff', fontSize: '13px', cursor: 'pointer', fontWeight: 500 },
      instanceRow: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 0', borderTop: '1px solid rgba(128,128,128,0.16)' },
      instanceMain: { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 },
      instanceName: { fontSize: '13px', fontWeight: 600 },
      meta: { fontSize: '12px', opacity: 0.62, display: 'flex', gap: '10px', flexWrap: 'wrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '1px 8px', borderRadius: '999px', border: '1px solid rgba(128,128,128,0.3)' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
      error: { fontSize: '12px', color: '#d64545', whiteSpace: 'pre-wrap' },
      notice: { fontSize: '12px', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.25)', lineHeight: 1.55 },
      dot: { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block' },
      swatches: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' },
      swatch: { width: '14px', height: '14px', borderRadius: '4px', cursor: 'pointer', padding: 0 },
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

    function InstanceRow({ instance, onStart, onStop, onRemove, onColor, palette, busy }) {
      const running = Boolean(instance.running)
      const ready = running && !instance.problem
      const statusText = !running ? 'stopped' : instance.problem ? 'unready' : 'running'
      const statusLabel = { stopped: '已停止', unready: '未就绪', running: '运行中' }[statusText]
      const statusColor = statusText === 'running' ? '#2fbf71' : statusText === 'unready' ? '#e0a21a' : 'rgba(128,128,128,0.6)'
      return h('div', { style: styles.instanceRow },
        h('div', { style: styles.instanceMain },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', {
              style: { ...styles.dot, width: '9px', height: '9px', background: instance.color || '#7A8CA0', boxShadow: '0 0 0 2px rgba(128,128,128,0.16)' },
              title: '工作区颜色 ' + (instance.color || '默认'),
            }),
            h('span', { style: styles.instanceName }, instance.name),
            h('span', { style: styles.badge },
              h('span', { style: { ...styles.dot, background: statusColor } }),
              statusLabel,
            ),
          ),
          h('div', { style: styles.meta },
            h('span', null, instance.repo || '未设置仓库'),
            instance.port ? h('span', null, '端口 ' + instance.port) : h('span', null, '端口待分配'),
            instance.accounts && instance.accounts.agent ? h('span', null, '智能体 ' + instance.accounts.agent) : null,
            instance.url
              ? h('a', { href: instance.url, target: '_blank', rel: 'noreferrer', style: { color: '#4B6BFB', textDecoration: 'none' } }, '打开面板')
              : null,
            formatLoad(instance.load) ? h('span', null, formatLoad(instance.load)) : null,
          ),
          h('div', { style: styles.swatches },
            ...(palette || PALETTE_FALLBACK).map((color) => h('button', {
              key: color,
              type: 'button',
              title: '把工作区颜色改成 ' + color,
              disabled: busy,
              style: {
                ...styles.swatch,
                background: color,
                opacity: busy ? 0.5 : 1,
                outline: String(instance.color || '').toUpperCase() === color ? '2px solid rgba(75,107,251,0.85)' : '1px solid rgba(128,128,128,0.28)',
              },
              onClick: () => onColor(instance, color),
            })),
          ),
          instance.problem ? h('div', { style: styles.error }, instance.problem.code || JSON.stringify(instance.problem)) : null,
        ),
        h('div', { style: styles.actions },
          running
            ? h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => onStop(instance) }, '停止')
            : h('button', { type: 'button', style: styles.buttonPrimary, disabled: busy, onClick: () => onStart(instance) }, '启动'),
          h('button', { type: 'button', style: { ...styles.button, opacity: busy ? 0.5 : 1 }, disabled: busy, onClick: () => onRemove(instance) }, '移除'),
        ),
      )
    }

    function SuperAgentManagerPanel() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [busy, setBusy] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [form, setForm] = React.useState({ name: '', repoName: '', owner: '', private: true })
      const [removeFiles, setRemoveFiles] = React.useState(false)

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, loading: true, error: null }))
        try {
          const data = await apiFetch(LIST_PATH)
          setState({ loading: false, error: null, data })
        } catch (error) {
          setState({ loading: false, error: error && error.message ? error.message : String(error), data: null })
        }
      }, [])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        // A tab switched on/off in the Super Agent stage flips the same registry the
        // settings page renders, so listen for it and re-read instead of going stale.
        const onChange = () => { void load() }
        window.addEventListener(INSTANCES_EVENT, onChange)
        return () => window.removeEventListener(INSTANCES_EVENT, onChange)
      }, [load])

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

      const create = React.useCallback(async () => {
        const name = form.name.trim()
        if (!name) {
          setMessage({ kind: 'error', text: '请先填写项目名称。' })
          return
        }
        setCreating(true)
        setMessage(null)
        try {
          const payload = await apiFetch(CREATE_PATH, {
            method: 'POST',
            body: {
              name,
              repoName: form.repoName.trim() || undefined,
              owner: form.owner.trim() || undefined,
              private: form.private,
              createRepo: true,
            },
            timeoutMs: CREATE_TIMEOUT_MS,
          })
          await load()
          notifyInstancesChanged()
          const repo = payload && payload.instance ? payload.instance.repo : name
          if (payload && payload.started) {
            const portNote = payload.workspace && payload.workspace.port ? '端口 ' + payload.workspace.port + ' 已就绪' : '但实例还没起来'
            const configNote = payload.configureError ? '，但配置没写完：' + payload.configureError : ''
            setMessage({ kind: !payload.configureError ? 'ok' : 'warn', text: '已创建：' + repo + '，' + portNote + configNote })
          } else {
            setMessage({ kind: 'warn', text: (payload && payload.error) || '实例已创建但还没启动完成，稍后刷新看看。' })
          }
          setForm({ name: '', repoName: '', owner: '', private: true })
        } catch (error) {
          setMessage({ kind: 'error', text: error && error.message ? error.message : String(error) })
        } finally {
          setCreating(false)
        }
      }, [form, load])

      const data = state.data
      const viewer = data && data.viewer ? data.viewer : ''
      const instances = data && Array.isArray(data.instances) ? data.instances : []
      const noticeColor = message ? (message.kind === 'error' ? '#d64545' : message.kind === 'warn' ? '#b8860b' : '#2fbf71') : 'inherit'

      return h('div', { style: styles.root },
        h('div', { style: styles.header },
          h('div', { style: styles.title }, 'Super Agent 管理'),
          h('div', { style: styles.hint }, '每个项目一个独立的 Super Agent：独立 GitHub 仓库、独立工作区，互不影响。'),
        ),
        h('div', { style: styles.card },
          h('div', { style: styles.cardTitle }, '新建项目'),
          h('div', { style: styles.row },
            h('label', { style: styles.field },
              h('span', { style: styles.label }, '项目名称'),
              h('input', {
                style: styles.input,
                value: form.name,
                placeholder: '例如：骰子棋旅',
                onChange: (event) => setForm({ ...form, name: event.target.value }),
              }),
            ),
            h('label', { style: styles.field },
              h('span', { style: styles.label }, 'GitHub 仓库名'),
              h('input', {
                style: styles.input,
                value: form.repoName,
                placeholder: '留空按项目名生成',
                onChange: (event) => setForm({ ...form, repoName: event.target.value }),
              }),
            ),
          ),
          h('div', { style: styles.switchRow },
            h('input', {
              type: 'checkbox',
              checked: form.private,
              onChange: (event) => setForm({ ...form, private: event.target.checked }),
            }),
            h('span', null, '私有仓库（推荐：智能体可以看到工作目录里的文件，私有仓库才不会把代码公开）'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            h('button', {
              type: 'button',
              style: { ...styles.buttonPrimary, opacity: creating ? 0.6 : 1 },
              disabled: creating || busy,
              onClick: create,
            }, creating ? '创建中…' : '一键创建'),
            creating ? h('span', { style: styles.hint }, '正在创建仓库、克隆并启动，大约 30 秒…') : null,
            viewer ? h('span', { style: styles.hint }, '使用智能体账号 ' + viewer) : null,
          ),
        ),
        message ? h('div', { style: { ...styles.notice, color: noticeColor } }, message.text) : null,
        h('div', { style: styles.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: styles.cardTitle }, '实例' + (instances.length ? '（' + instances.length + '）' : '')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
              h('label', { style: styles.switchRow },
                h('input', {
                  type: 'checkbox',
                  checked: removeFiles,
                  onChange: (event) => setRemoveFiles(event.target.checked),
                }),
                h('span', null, '移除时删除本地 checkout'),
              ),
              h('button', { type: 'button', style: styles.button, disabled: busy || state.loading, onClick: load }, '刷新'),
            ),
          ),
          state.error ? h('div', { style: styles.error }, state.error) : null,
          state.loading && !instances.length ? h('div', { style: styles.hint }, '加载中…') : null,
          !state.loading && !state.error && !instances.length ? h('div', { style: styles.hint }, '还没有实例。先在上面创建一个项目。') : null,
          instances.map((instance) => h(InstanceRow, {
            key: instance.id,
            instance,
            busy,
            onStart: (item) => act(START_PATH, { id: item.id }, 120000),
            onStop: (item) => act(STOP_PATH, { id: item.id }),
            onRemove: (item) => act(REMOVE_PATH, { id: item.id, deleteFiles: removeFiles }),
            onColor: recolor,
            palette: (state.data && state.data.palette) || PALETTE_FALLBACK,
          })),
        ),
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
      frame: { width: '100%', height: '100%', border: 0, display: 'block' },
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

    // Every embedded client runs on its own origin (``<instance-id>.localhost``) so it
  // gets its own localStorage / IndexedDB / service-worker scope. Sharing the host
  // origin made sessions, model choice and workspace selection bleed between the host
  // client and every Super Agent panel. The proxy itself is path based, so the origin
  // only changes what the browser partitions - requests still land on the same web
  // server and are forwarded to the instance port.
  function instanceOrigin(id) {
    const label = String(id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
    if (!label) return ''
    const port = window.location.port ? ':' + window.location.port : ''
    return 'http://' + label + '.localhost' + port
  }

  function instanceFrameUrl(item) {
    if (!item || !item.id) return ''
    return instanceOrigin(item.id) + '/sa/' + encodeURIComponent(item.id) + '/'
  }

  function StagePanel() {
      const [data, setData] = React.useState(null)
      const [active, setActive] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)
      // Instance id whose start/stop switch is mid-flight, so the switch can't be
      // double-toggled while the backend process is coming up or shutting down.
      const [toggling, setToggling] = React.useState(null)
      // Panels whose tab has been opened at least once; their iframes stay mounted.
      const opened = React.useRef(new Set())
      React.useEffect(() => {
        if (active) opened.current.add(active)
      }, [active])

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

      // Come back to this page after working elsewhere and the embedded instance is
      // reloaded, so conversations created or deleted outside show up without a manual
      // refresh. Short absences are ignored to keep scroll position and typing intact.
      const hiddenSince = React.useRef(0)
      React.useEffect(() => {
        const onVisibility = () => {
          if (document.hidden) { hiddenSince.current = Date.now(); return }
          const away = hiddenSince.current ? Date.now() - hiddenSince.current : 0
          hiddenSince.current = 0
          if (away > 20000) setNonce((value) => value + 1)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])

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
            running ? null : h('span', { key: 'state', style: { opacity: 0.55 } }, '已停止'),
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

      // Mount a panel the first time its tab is opened instead of booting every
      // instance UI at once: three embedded clients used to start in parallel even
      // though only one is visible. Once mounted a frame stays alive (hidden), so
      // switching tabs keeps scroll position and in-flight conversations. A stopped
      // instance is unmounted instead of left on its dead page, so starting it again
      // loads a fresh document.
      const frames = instances
        .filter((item) => item.running && item.url && (item.id === active || opened.current.has(item.id)))
        .map((item) => h('iframe', {
          key: 'frame-' + item.id + ':' + nonce,
          title: item.name || item.id,
          src: instanceFrameUrl(item),
          style: item.id === active ? stageStyles.frame : Object.assign({}, stageStyles.frame, { display: 'none' }),
          allow: 'clipboard-read; clipboard-write',
        }))

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
            title: '重新加载这个项目的界面（登录失效时用这个）',
            onClick: () => { setNonce((value) => value + 1); void load() },
          }, '刷新'),
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
        h('div', { style: stageStyles.box }, frames, body),
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
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
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
