import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { request as httpRequest } from 'node:http'

export const name = 'dsh-superagent-manager'
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-superagent-manager'
const TEMPLATE_PROFILE = 'superagent'
// Every project is its own dsh-superagent process on its own port, driven from here.
let hostContext = null

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Root of everything this manager owns. DSH_SUPERAGENT_MANAGER_HOME points a scratch
 * instance at a throwaway directory so experiments never touch the real registry.
 */
function managerRoot() {
  return process.env.DSH_SUPERAGENT_MANAGER_HOME || join(dshHome(), 'state')
}

function managerDir() {
  return join(managerRoot(), 'superagent-manager')
}

function registryPath() {
  return join(managerDir(), 'instances.json')
}

function ghAgent() {
  const local = join(homedir(), '.local', 'bin', 'gh-agent.exe')
  if (existsSync(local)) return local
  return 'C:/Program Files/GitHub CLI/gh.exe'
}

/**
 * How to launch a child instance. `dsh.cmd` goes through cmd.exe, and with a
 * redirected stdio the printed token URL never reaches the log file, so prefer
 * node + the CLI entry directly and keep the .cmd as a fallback.
 */
function readRegistry() {
  try {
    const doc = JSON.parse(readFileSync(registryPath(), 'utf8'))
    return Array.isArray(doc.instances) ? doc : { instances: [] }
  } catch {
    return { instances: [] }
  }
}

function writeRegistry(doc) {
  mkdirSync(managerDir(), { recursive: true })
  const target = registryPath()
  const temporary = target + '.tmp'
  writeFileSync(temporary, JSON.stringify(doc, null, 2) + '\n')
  renameSync(temporary, target)
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function isLocalRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1 << 20) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      try { resolve(JSON.parse(text)) } catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)) }
    })
    req.on('error', reject)
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 8 << 20, timeout: options.timeoutMs || 120000, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && typeof error.code === 'number' ? error.code : error ? -1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message) : null })
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const FIRST_PORT = 3090
const PORT_LIMIT = 240

function instancePort(entry) {
  return Number(entry.port) || 0
}

function lockPath(entry) {
  const text = String(entry.stateDir || '').replace(/\\/g, '/')
  return join(managerRoot(), `${text.split('/').pop()}.lock`)
}

/** A free port: not claimed by another instance and not already listening. */
async function pickPort(registry) {
  const used = new Set((registry.instances || []).map((entry) => instancePort(entry)).filter(Boolean))
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_LIMIT; port += 1) {
    if (used.has(port)) continue
    if (await probePort(port)) continue
    return port
  }
  throw new Error('no free port left for a new instance')
}

/** The profile that already has dsh-superagent installed; its node_modules is reused. */
function anchorProfile() {
  try {
    for (const name of readdirSync(join(dshHome(), 'profiles'))) {
      const dir = join(dshHome(), 'profiles', name)
      if (existsSync(join(dir, 'node_modules', 'dsh-superagent', 'package.json'))) return dir
    }
  } catch { /* no profiles */ }
  return ''
}

/**
 * Every project owns a tiny profile: its own port, its own state directory, and a
 * junction to the anchor profile's node_modules so nothing needs installing twice.
 */
function ensureProfile(entry) {
  const anchor = anchorProfile()
  if (!anchor) throw new Error('no client profile has dsh-superagent installed')
  const dir = join(dshHome(), 'profiles', entry.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${entry.id}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent'] } },
  }, null, 2) + '\n')
  for (const name of ['cordis.yml', 'pnpm-workspace.yaml']) {
    const from = join(anchor, name)
    if (existsSync(from) && !existsSync(join(dir, name))) writeFileSync(join(dir, name), readFileSync(from))
  }
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${entry.port}`,
    '- id: dsh-superagent',
    '  name: dsh-superagent',
    '  config:',
    `    stateDir: '${String(entry.stateDir).replace(/\\/g, '\\\\')}'`,
    '',
  ].join('\n'))
  const link = join(dir, 'node_modules')
  if (!existsSync(link)) symlinkSync(join(anchor, 'node_modules'), link, 'junction')
}

/** node + the CLI entry beats dsh.cmd here: cmd.exe hides the printed token URL. */
function launcher() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const cli = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const node = 'C:/Program Files/nodejs/node.exe'
  if (existsSync(cli) && existsSync(node)) return { command: node, args: [cli], shell: false }
  return { command: join(appData, 'npm', 'dsh.cmd'), args: [], shell: true }
}

function lastTokenUrl(logPath) {
  try {
    const matches = readFileSync(logPath, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/g)
    return matches ? matches[matches.length - 1] : ''
  } catch {
    return ''
  }
}

async function readTokenUrl(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(logPath, 'utf8')
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)
      if (match) return match[0]
    } catch { /* the log appears with the first line */ }
    await sleep(400)
  }
  return ''
}

/**
 * Every PID listening on a local port.
 *
 * `netstat` is best-effort: a sandboxed host may refuse to start it, so an empty
 * list means "not discoverable", not "nothing is listening". Callers fall back to
 * the PID recorded in the registry, which is why they cannot treat this as truth.
 */
function pidsOnPort(port) {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    const pids = new Set()
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue
      if (Number(parts[1].split(':').pop()) !== Number(port)) continue
      const pid = Number(parts[4])
      if (pid > 0) pids.add(pid)
    }
    return [...pids]
  } catch { return [] }
}

function pidOnPort(port) {
  return pidsOnPort(port)[0] || 0
}

/** `kill(pid, 0)` only probes existence; EPERM still means the process exists. */
function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/**
 * Terminates one process tree. `taskkill` is preferred because it takes the
 * `dsh` children with it; when the host cannot start it we still `kill` the pid.
 */
async function terminatePid(pid) {
  if (!pid) return { pid, ok: false, via: 'none' }
  const result = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 30000 })
  if (result.ok) return { pid, ok: true, via: 'taskkill' }
  try {
    process.kill(pid)
    return { pid, ok: true, via: 'kill' }
  } catch (error) {
    return { pid, ok: false, via: 'none', error: result.error || String((error && error.message) || error) }
  }
}

/** The host Workspace registry: one sidebar Workspace belongs to every project. */

/**
 * Registers the project's own Workspace over its repository checkout. DSH keys a
 * Workspace by canonical directory, so calling this twice returns the existing
 * Workspace instead of creating a duplicate.
 */

async function probeState(entry) {
  const port = instancePort(entry)
  if (!port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/orchestrator/api/state`, {
      headers: { 'x-orchestrator-request': '1' },
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return null
    const body = await res.json()
    return {
      problem: (body.setup && body.setup.problem) || null,
      accounts: (body.setup && body.setup.accounts) || null,
      load: body.load || null,
      paused: Boolean(body.paused),
      sources: body.sources || null,
    }
  } catch {
    return null
  }
}

function slug(text) {
  const cleaned = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || `project-${Date.now().toString(36)}`
}

function repoNameOf(text) {
  const cleaned = String(text || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'project'
}

async function gh(args, timeoutMs = 120000) {
  const result = await run(ghAgent(), args, { timeoutMs, env: await netEnv() })
  if (!result.ok) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.error || '').trim().slice(0, 400)}`)
  return result.stdout.trim()
}

/**
 * github.com is not reachable from this machine without the local HTTP proxy,
 * so every git/gh call inherits it when the proxy is actually listening.
 * Probed once and cached; an absent proxy simply means a direct connection.
 */
const PROXY_CANDIDATES = ['http://127.0.0.1:7897']
let proxyCache = null

function probePort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = netConnect({ port: Number(port), host })
    const done = (value) => { socket.removeAllListeners(); socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function detectProxy() {
  if (proxyCache !== null) return proxyCache
  proxyCache = ''
  for (const candidate of PROXY_CANDIDATES) {
    let url = null
    try { url = new URL(candidate) } catch { continue }
    if (await probePort(url.port, url.hostname)) { proxyCache = candidate; break }
  }
  return proxyCache
}

async function netEnv(extra = {}) {
  const proxy = await detectProxy()
  const env = { ...process.env, ...extra }
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
  }
  return env
}

let loginCache = { value: null, at: 0 }
const LOGIN_TTL_MS = 60000

/** gh costs 2-4 s behind the proxy; the panel refreshes far more often than a login changes. */
async function agentLogin(force = false) {
  const now = Date.now()
  if (!force && loginCache.value !== null && now - loginCache.at < LOGIN_TTL_MS) return loginCache.value
  let value = ''
  try {
    value = (await gh(['api', 'user', '--jq', '.login'])).trim()
  } catch {
    value = ''
  }
  loginCache = { value, at: Date.now() }
  return value
}

/**
 * One project owns one repository. An existing repository is reused rather than
 * re-created, so retrying a half-finished project never fights the first attempt
 * and never deletes a repository this manager did not create.
 */
async function ensureRepository({ owner, repoName, viewer, isPrivate }) {
  const repo = `${owner}/${repoName}`
  const probe = await run(ghAgent(), ['api', `repos/${repo}`, '--jq', '.full_name'], { env: await netEnv() })
  if (probe.ok) return { repo, created: false }
  await gh(['api', '-X', 'POST', viewer && owner === viewer ? 'user/repos' : `orgs/${owner}/repos`, '-f', `name=${repoName}`, '-F', `private=${isPrivate ? 'true' : 'false'}`, '-f', 'description=Managed by dsh-superagent-manager', '--jq', '.full_name'])
  if (viewer && owner === viewer) {
    // The agent owns the repository; hand administration to the operator so it stays theirs.
    const operator = process.env.SUPERAGENT_MANAGER_OPERATOR || 'SolaNoKan'
    if (operator && operator !== viewer) {
      await run(ghAgent(), ['api', '-X', 'PUT', `/repos/${repo}/collaborators/${operator}`, '-f', 'permission=admin'], { env: await netEnv() }).catch(() => null)
    }
  }
  return { repo, created: true }
}

/** Clones the project's repository; the instance process starts afterwards. */
async function scaffold({ name, repo, repoName, owner, managedSlug }) {
  const id = managedSlug
  const stateDir = join(managerRoot(), id)

  const cloneDir = join(stateDir, 'repos', repoName)
  mkdirSync(join(stateDir, 'repos'), { recursive: true })
  if (!existsSync(cloneDir)) {
    await gh(['repo', 'clone', repo, cloneDir, '--', '--depth', '1'], 300000)
  }
  // The executor fetches new ticket refs inside `prepare`, so the clone itself must
  // know which account may read the (possibly private) repository.
  await run('git', ['-C', cloneDir, 'config', 'credential.helper', `!"${ghAgent()}" auth git-credential`])
  // Keep the proxy in the clone itself: the executor fetches new refs later,
  // in a worker that does not inherit this process' environment.
  const proxy = await detectProxy()
  if (proxy) await run('git', ['-C', cloneDir, 'config', 'http.proxy', proxy])

  // In-process mount: only the state directory and its checkout are real.
  return { id, repo, stateDir, cloneDir }
}

/** Starts (or reuses) the project's own dsh process. */
async function startInstance(entry, registry) {
  if (await probeState(entry)) return { started: true, url: entry.url || '', alreadyRunning: true }
  if (!instancePort(entry)) entry.port = await pickPort(registry || readRegistry())
  ensureProfile(entry)
  mkdirSync(entry.stateDir, { recursive: true })
  rmSync(lockPath(entry), { recursive: true, force: true })
  const logPath = join(entry.stateDir, 'web.log')
  const out = openSync(logPath, 'w')
  const { command, args, shell } = launcher()
  const child = spawn(command, [...args, '--profile', entry.id, '--port', String(entry.port), '--host', '127.0.0.1', '--no-open'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    shell: Boolean(shell),
    env: { ...process.env, DSH_SUPERAGENT_MANAGER_HOME: managerRoot() },
  })
  child.unref()
  entry.pid = child.pid
  entry.url = await readTokenUrl(logPath, 90000) || entry.url || ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await probeState(entry)) return { started: true, url: entry.url }
    await sleep(1000)
  }
  return { started: false, error: `instance ${entry.id} did not answer on port ${entry.port}` }
}

/**
 * Stops the project's process tree and clears the orchestrator lock it leaves
 * behind. Discovery is layered: port listeners first, then the registry PID, so
 * a host that cannot run `netstat` (sandboxed) still stops its instances.
 */
async function stopInstance(entry) {
  if (!(await probeState(entry))) {
    rmSync(lockPath(entry), { recursive: true, force: true })
    entry.pid = 0
    return { stopped: true, alreadyStopped: true, targets: [] }
  }
  const targets = new Set(pidsOnPort(entry.port))
  if (processAlive(entry.pid)) targets.add(entry.pid)
  const attempts = []
  for (const pid of targets) attempts.push(await terminatePid(pid))
  let running = true
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250)
    if (!(await probeState(entry))) { running = false; break }
  }
  rmSync(lockPath(entry), { recursive: true, force: true })
  if (!running) entry.pid = 0
  return { stopped: !running, targets: [...targets], attempts }
}

async function orchestratorFetch(entry, path, options = {}) {
  const port = instancePort(entry)
  if (!port) throw new Error('the instance has no port yet')
  const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api${path}`, {
    method: options.method || 'GET',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 20000),
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { raw: text.slice(0, 400) } }
  if (!response.ok) throw new Error(`orchestrator ${path} failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`)
  return payload
}

function prepareCommand(cloneDir, proxy) {
  const root = cloneDir.replace(/\\/g, '/')
  const flag = proxy ? ` -c http.proxy=${proxy}` : ''
  return `R='${root}'; git${flag} -C "$R" fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "\${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" && git${flag} -C "$R" worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"`
}

const BLOCKED_COMMANDS = [
  'ssh', 'scp', 'sftp', 'sudo', 'su', 'curl', 'wget', 'nc', 'telnet',
  'schtasks', 'shutdown', 'diskpart', 'bcdedit', 'format', 'reg', 'netsh',
  'vssadmin', 'takeown', 'icacls',
]

/**
 * Points a freshly started instance at its repository and gives it the same
 * policy, executor and command guard as the first instance. Without this the
 * instance boots with an empty settings database and refuses to accept work.
 */
async function waitForSource(entry, kind, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await orchestratorFetch(entry, '/settings')
    const sources = (last && last.sources) || []
    if (sources.some((source) => source.id === kind)) return last
    await sleep(500)
  }
  return last
}

async function configureInstance(entry, operator) {
  // The source plugin activates only after the runtime provides the orchestrator service, so the
  // first settings write can land before the source block exists. Retry the whole write instead of
  // leaving a half-configured instance behind.
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await waitForSource(entry, 'github', 5000)
      return await writeInstanceSettings(entry, operator)
    } catch (error) {
      lastError = error
      const message = String(error && error.message ? error.message : error)
      if (!/sourceNotInstalled|Source not found|not installed/i.test(message)) throw error
      await sleep(3000)
    }
  }
  throw lastError || new Error('instance settings could not be written')
}

async function writeInstanceSettings(entry, operator) {
  const settings = await orchestratorFetch(entry, '/settings')
  const blocks = settings.blocks || {}
  const sources = Array.isArray(settings.sources) ? settings.sources : []
  const github = sources.find((source) => source.id === 'github') || { value: {}, revision: 0 }
  const policy = blocks.policy || { value: { rules: [] }, revision: 0 }
  const executor = blocks.executor || { value: {}, revision: 0 }

  const githubValue = {
    enabled: true,
    config: {
      ...(github.value && github.value.config ? github.value.config : {}),
      repository: entry.repo,
      cli: ghAgent().replace(/\\/g, '/'),
      pollSeconds: 60,
      failuresBeforeError: 3,
    },
  }
  await orchestratorFetch(entry, '/settings/source:github', { method: 'PUT', body: { value: githubValue, revision: github.revision || 0 } })

  const allowed = operator ? [{ id: operator }] : []
  const policyValue = {
    ...(policy.value || {}),
    sources: { ...((policy.value && policy.value.sources) || {}), github: { allowed, bots: [] } },
  }
  await orchestratorFetch(entry, '/settings/policy', { method: 'PUT', body: { value: policyValue, revision: policy.revision || 0 } })

  const executorValue = {
    ...(executor.value || {}),
    model: (executor.value && executor.value.model) || null,
    maxWorkers: (executor.value && executor.value.maxWorkers) || 3,
    directory: '',
    prepare: prepareCommand(entry.clone || '', await detectProxy()),
    blockedCommands: BLOCKED_COMMANDS,
  }
  await orchestratorFetch(entry, '/settings/executor', { method: 'PUT', body: { value: executorValue, revision: executor.revision || 0 } })

  try {
    await orchestratorFetch(entry, '/setup/check', { method: 'POST' })
  } catch {
    // The check reports problems as data; a 4xx here still means the settings did land.
  }
  return probeState(entry)
}

/** Sidebar colours: one per project so a workspace folder is recognisable at a glance. */
export const PALETTE = ['#5B8DEF', '#F0633C', '#2FB344', '#B15CE0', '#E8A33D', '#12A5A5', '#D94F8A', '#7A8CA0']

function normalizeColor(value) {
  const text = String(value || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : ''
}

/** Unknown colours get the least used palette entry, so new projects never collide by default. */
function pickColor(requested, registry) {
  const explicit = normalizeColor(requested)
  if (explicit) return explicit
  const used = new Map()
  for (const entry of registry.instances || []) {
    const color = normalizeColor(entry.color)
    if (color) used.set(color, (used.get(color) || 0) + 1)
  }
  let best = PALETTE[0]
  let bestCount = Number.POSITIVE_INFINITY
  for (const color of PALETTE) {
    const count = used.get(color) || 0
    if (count < bestCount) { best = color; bestCount = count }
  }
  return best
}

/**
 * Sidebar workspaces that point at this instance: the state dir itself or the
 * repository checkout inside it. A hand-made workspace has no id in the registry,
 * so the path is the only thing that ties it to its project.
 */
function workspacesFor(entry) {
  const root = String(entry.stateDir || '').toLowerCase().replace(/[\\/]+$/, '')
  if (!root) return []
  let table = {}
  try {
    const doc = JSON.parse(readFileSync(join(dshHome(), 'storages', 'workspace.json'), 'utf8'))
    table = (doc && doc.tables && doc.tables.workspaces) || {}
  } catch {
    return []
  }
  return Object.keys(table).filter((id) => {
    const path = String((table[id] && table[id].path) || '').toLowerCase().replace(/[\\/]+$/, '')
    return path === root || path.startsWith(root + '\\') || path.startsWith(root + '/')
  })
}

/**
 * Registers the project's sidebar folder. Best effort: when the workspace service is
 * absent (a headless or stripped profile) the instance still runs on its own port.
 */
async function attachWorkspace(entry) {
  // Cordis refuses a plain property read without inject; get() is the supported way.
  let service
  try {
    service = hostContext.get ? hostContext.get('workspaceRegistry') : undefined
  } catch {
    service = undefined
  }
  // Point the workspace at the project checkout, not the manager's state directory: the
  // checkout is the folder the agent actually edits, and conversations are stored per
  // folder, so this is the one place where the client and the instance see each other's
  // sessions.
  const directory = entry.clone || entry.stateDir
  if (!service || typeof service.create !== 'function' || !directory) return null
  try {
    mkdirSync(directory, { recursive: true })
    const workspace = await service.create(directory, entry.name)
    return workspace && workspace.id ? String(workspace.id) : null
  } catch {
    return null
  }
}

async function describe(entry) {
  const state = await probeState(entry)
  if (state) {
    const tokenUrl = lastTokenUrl(join(entry.stateDir, 'web.log'))
    if (tokenUrl) entry.url = tokenUrl
  }
  return {
    ...entry,
    workspaces: workspacesFor(entry),
    running: Boolean(state),
    problem: state ? state.problem : null,
    accounts: state ? state.accounts : null,
    load: state ? state.load : null,
    paused: state ? state.paused : null,
  }
}

let busyAction = ''

/** One project operation at a time; a double click must not build two repositories. */
function claim(name) {
  if (busyAction) throw new Error(`another operation is already running: ${busyAction}`)
  busyAction = name
  return () => { busyAction = '' }
}

/**
 * Brings back the instances that were running when the client last quit. Instances
 * are detached processes, so a clean client exit leaves them alive; this covers the
 * machine-reboot / crash case. Starts are sequential to avoid a thundering herd.
 */
async function autoResume(log) {
  console.log("[dsh-superagent-manager] auto-resume started")
  const registry = readRegistry()
  const targets = registry.instances.filter((entry) => entry.wasRunning !== false)
  const report = []
  for (const entry of targets) {
    try {
      if (await probeState(entry)) { ensureUpgradeRoute(entry); report.push({ id: entry.id, state: 'already-running' }); continue }
      const result = await startInstance(entry, registry)
      entry.wasRunning = true
      writeRegistry(registry)
      if (result.started) ensureUpgradeRoute(entry)
      report.push({ id: entry.id, state: result.started ? 'started' : 'failed', error: result.error || null })
    } catch (error) {
      report.push({ id: entry.id, state: 'failed', error: String(error && error.message ? error.message : error) })
    }
  }
  if (report.length) log(report)
  return report
}

const proxyCookies = new Map()

/**
 * The instance's UI is served by its own dsh web process, which hands out a
 * `SameSite=Strict` cookie on first visit with `?token=`. Browsers refuse to set that
 * cookie from a sub-frame, so an iframe pointed straight at the instance stays logged
 * out. We exchange the token here (server side) and replay the cookie for the browser,
 * letting the panel embed http://<client>/sa/<id>/ without any auth in the page.
 */
function exchangeCookie(entry) {
  return new Promise((resolve, reject) => {
    const token = /[?&]token=([^&#]+)/.exec(entry.url || '')
    if (!token) { resolve(''); return }
    const request = httpRequest({
      host: '127.0.0.1',
      port: entry.port,
      method: 'GET',
      path: '/?token=' + encodeURIComponent(decodeURIComponent(token[1])),
      headers: { accept: 'text/html' },
    }, (response) => {
      const raw = response.headers['set-cookie']
      response.resume()
      const value = Array.isArray(raw) ? raw[0] : raw
      resolve(value ? String(value).split(';')[0] : '')
    })
    request.on('error', reject)
    request.setTimeout(8000, () => { request.destroy(new Error('cookie exchange timed out')) })
    request.end()
  })
}

async function cookieFor(entry) {
  const key = entry.id + '|' + entry.port + '|' + entry.url
  const cached = proxyCookies.get(key)
  if (cached) return cached
  const value = await exchangeCookie(entry)
  if (value) proxyCookies.set(key, value)
  return value
}

function proxyToInstance(entry, target, req, res) {
  let cookie = ''
  const origin = 'http://127.0.0.1:' + entry.port
  cookieFor(entry).then((value) => {
    cookie = value
    const headers = Object.assign({}, req.headers)
    delete headers.host
    delete headers.cookie
    delete headers.connection
    delete headers.origin
    delete headers.referer
    if (cookie) headers.cookie = cookie
    headers.host = '127.0.0.1:' + entry.port
    headers.origin = origin
    headers.referer = origin + '/'
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: entry.port,
      method: req.method,
      path: target,
      headers,
    }, (response) => {
      const responseHeaders = Object.assign({}, response.headers)
      delete responseHeaders['set-cookie']
      delete responseHeaders['strict-transport-security']
      if (responseHeaders.location) {
        const location = String(responseHeaders.location)
        if (location.startsWith('/')) responseHeaders.location = '/sa/' + encodeURIComponent(entry.id) + location
      }
      res.writeHead(response.statusCode || 502, responseHeaders)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('instance proxy failed: ' + String(error && error.message ? error.message : error))
      } else {
        res.end()
      }
    })
    req.pipe(upstream)
  }).catch((error) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('instance proxy failed: ' + String(error && error.message ? error.message : error))
  })
}


const upgradeRoutes = new Map()

function proxyUpgrade(entry, req, socket, head) {
  cookieFor(entry).then((cookie) => {
    const headers = Object.assign({}, req.headers)
    delete headers.host
    delete headers.cookie
    delete headers.origin
    delete headers.referer
    if (cookie) headers.cookie = cookie
    headers.host = '127.0.0.1:' + entry.port
    headers.origin = 'http://127.0.0.1:' + entry.port
    headers.referer = 'http://127.0.0.1:' + entry.port + '/'
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: entry.port,
      method: 'GET',
      path: '/api/remote.mux',
      headers,
    })
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        lines.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1])
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
      if (head && head.length) upstreamSocket.write(head)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstream.on('response', (response) => {
      response.resume()
      socket.destroy()
    })
    upstream.on('error', (error) => { console.log('[dsh-superagent-manager] ws upstream error ' + String(error && error.message ? error.message : error)); socket.destroy() })
    upstream.end()
  }).catch(() => socket.destroy())
}

/**
 * The embedded client speaks to the instance over a WebSocket upgrade on
 * /api/remote.mux. webserver upgrade routes are exact-path only, so each
 * instance gets its own route under the /sa prefix and we relay the socket.
 */
function ensureUpgradeRoute(entry) {
  if (upgradeRoutes.has(entry.id)) return
  if (!hostContext || typeof hostContext.webServer.registerUpgrade !== 'function') return
  const path = '/sa/' + encodeURIComponent(entry.id) + '/api/remote.mux'
  try {
    const dispose = hostContext.webServer.registerUpgrade({
      path,
      handler: (req, socket, head) => {
        const current = readRegistry().instances.find((item) => item.id === entry.id)
        if (!current || !current.port) { socket.destroy(); return }
        console.log('[dsh-superagent-manager] ws upgrade ' + String(req.url || '') + ' -> ' + current.port)
        proxyUpgrade(current, req, socket, head)
      },
    })
    upgradeRoutes.set(entry.id, dispose)
  } catch (error) {
    console.warn('[dsh-superagent-manager] upgrade route failed: ' + String(error && error.message ? error.message : error))
  }
}

function dropUpgradeRoute(id) {
  const dispose = upgradeRoutes.get(id)
  if (dispose) {
    try { dispose() } catch {}
    upgradeRoutes.delete(id)
  }
}

export function apply(ctx) {

  hostContext = ctx
  const disposers = []
  const register = (path, handler) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}${path}`,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) { writeJson(res, 403, { error: 'local requests only' }); return }
        try {
          await handler(req, res)
        } catch (error) {
          writeJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }))
  }

  // Same-origin proxy for embedded instance UIs: /sa/<id>/… → 127.0.0.1:<port>/…
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: '/sa',
    handler: async (req, res) => {
      const raw = req.url || '/'
      const queryAt = raw.indexOf('?')
      const pathname = queryAt >= 0 ? raw.slice(0, queryAt) : raw
      const search = queryAt >= 0 ? raw.slice(queryAt) : ''
      const rest = pathname.slice('/sa'.length)
      const match = /^\/([^/]+)(.*)$/.exec(rest)
      if (!match) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('unknown super agent'); return }
      if (!isLocalRequest(req)) { writeJson(res, 403, { error: 'local requests only' }); return }
      const id = decodeURIComponent(match[1])
      const entry = readRegistry().instances.find((item) => item.id === id)
      if (!entry || !entry.port) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('super agent is not running'); return }
      const tail = match[2] && match[2].length ? match[2] : '/'
      // Serving the page is the first moment we know the instance is wanted;
      // register its realtime upgrade route here so the socket relay is ready.
      ensureUpgradeRoute(entry)
      proxyToInstance(entry, tail + search, req, res)
    },
  }))

  register('/instances', async (req, res) => {
    if ((req.method || 'GET') !== 'GET') { writeJson(res, 405, { error: 'GET only' }); return }
    const registry = readRegistry()
    const instances = []
    let dirty = false
    for (const entry of registry.instances) {
      // Entries created before colours existed get one on first sight.
      if (!normalizeColor(entry.color)) { entry.color = pickColor(null, registry); dirty = true }
      const knownUrl = entry.url
      const described = await describe(entry)
      if (described.running) ensureUpgradeRoute(entry)
      instances.push(described)
      // A workspace the operator created by hand adopts the project on first sight.
      if (!entry.workspaceId && described.workspaces.length) {
        entry.workspaceId = described.workspaces[0]
        described.workspaceId = entry.workspaceId
        dirty = true
      }
      // describe() re-reads the token the instance printed last; persist it so the
      // panel link keeps working after the instance restarts itself.
      if (entry.url !== knownUrl) dirty = true
    }
    if (dirty) {
      // Re-read before writing: start/stop/auto-resume may have touched the file while
      // we were probing, and clobbering their port or timestamp loses the instance.
      const fresh = readRegistry()
      for (const item of fresh.instances) {
        const seen = instances.find((candidate) => candidate.id === item.id)
        if (!seen) continue
        if (!normalizeColor(item.color)) item.color = seen.color
        if (seen.url) item.url = seen.url
        if (seen.workspaceId && !item.workspaceId) item.workspaceId = seen.workspaceId
      }
      writeRegistry(fresh)
    }
    const viewer = await agentLogin()
    writeJson(res, 200, {
      viewer,
      template: TEMPLATE_PROFILE,
      instances,
      palette: PALETTE,
      defaults: { operator: process.env.SUPERAGENT_MANAGER_OPERATOR || 'SolaNoKan' },
    })
  })

  register('/create', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const release = claim('create')
    try {
    const body = await readBody(req)
    const displayName = String(body.name || '').trim()
    if (!displayName) { writeJson(res, 400, { error: 'name is required' }); return }
    const viewer = await agentLogin()
    if (!viewer) { writeJson(res, 409, { error: 'the agent GitHub CLI is not signed in' }); return }
    const registry = readRegistry()
    const id = `superagent-${slug(displayName)}`
    if (registry.instances.some((entry) => entry.id === id)) { writeJson(res, 409, { error: `instance ${id} already exists` }); return }
    const owner = String(body.owner || viewer).trim()
    const repoName = repoNameOf(body.repoName || displayName)
    const createRepo = body.createRepo !== false
    const isPrivate = body.private !== false

    // The repository comes first: it is the one artifact a retry must not duplicate.
    const repository = createRepo
      ? await ensureRepository({ owner, repoName, viewer, isPrivate })
      : { repo: `${owner}/${repoName}`, created: false }

    const created = await scaffold({ name: displayName, repo: repository.repo, repoName, owner, managedSlug: id }).catch(async (error) => {
      // A half-built project is worse than none: undo only what this attempt made.
      if (repository.created) {
        try { await run(ghAgent(), ['repo', 'delete', repository.repo, '--yes'], { env: await netEnv() }) } catch {}
      }
      rmSync(join(dshHome(), 'state', id), { recursive: true, force: true })
      rmSync(join(dshHome(), 'profiles', id), { recursive: true, force: true })
      throw error
    })
    const entry = {
      id,
      name: displayName,
      repo: created.repo,
      owner,
      stateDir: created.stateDir,
      clone: created.cloneDir,
      createdAt: new Date().toISOString(),
      color: pickColor(body.color, registry),
      workspaceId: null,
    }
    // The sidebar folder is created here, before the process is registered, so the
    // operator sees the project by name instead of hunting for the state directory.
    let workspaceError = null
    entry.workspaceId = await attachWorkspace(entry)
    if (!entry.workspaceId) workspaceError = 'workspace registry is not available'
    registry.instances.push(entry)
    writeRegistry(registry)

    const started = await startInstance(entry, registry)
    let configured = null
    let configureError = null
    if (started.started) {
      try {
        configured = await configureInstance(entry, process.env.SUPERAGENT_MANAGER_OPERATOR || 'SolaNoKan')
      } catch (error) {
        configureError = String(error && error.message ? error.message : error)
      }
    }
    writeRegistry(registry)
    writeJson(res, started.started ? 200 : 202, {
      instance: await describe(entry),
      workspace: { directory: entry.stateDir, title: entry.name, port: entry.port, url: entry.url },
      workspaceError,
      repositoryCreated: repository.created,
      ...started,
      configured,
      configureError,
    })
    } finally {
      release()
    }
  })

  register('/start', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const release = claim('start')
    try {
    const body = await readBody(req)
    const registry = readRegistry()
    const entry = registry.instances.find((item) => item.id === body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    const started = await startInstance(entry, registry)
    if (started.started) { entry.wasRunning = true; ensureUpgradeRoute(entry) }
    let configureError = null
    if (started.started) {
      try {
        await configureInstance(entry, process.env.SUPERAGENT_MANAGER_OPERATOR || 'SolaNoKan')
      } catch (error) {
        configureError = String(error && error.message ? error.message : error)
      }
    }
    writeRegistry(registry)
    writeJson(res, started.started ? 200 : 500, { instance: await describe(entry), ...started, configureError })
    } finally {
      release()
    }
  })

  register('/color', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    // A malformed body is the caller's mistake, never a 500: validate before use.
    let body = null
    try {
      body = await readBody(req)
    } catch {
      writeJson(res, 400, { error: 'body must be JSON' })
      return
    }
    if (!body || typeof body !== 'object') { writeJson(res, 400, { error: 'body must be an object' }); return }
    const color = normalizeColor(body.color)
    if (!color) { writeJson(res, 400, { error: 'color must look like #RRGGBB' }); return }
    const registry = readRegistry()
    const entry = registry.instances.find((item) => item.id === body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    entry.color = color
    writeRegistry(registry)
    writeJson(res, 200, { instance: await describe(entry), palette: PALETTE })
  })

  register('/stop', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const body = await readBody(req)
    const registry = readRegistry()
    const entry = registry.instances.find((item) => item.id === body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    const stopped = await stopInstance(entry)
    // Only a confirmed stop clears the "should run" flag; a failed stop means the
    // instance is still alive and auto-resume must keep opting it in.
    entry.wasRunning = !stopped.stopped
    writeRegistry(registry)
    writeJson(res, 200, { stopped, instance: await describe(entry) })
  })

  register('/remove', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const body = await readBody(req)
    const registry = readRegistry()
    const entry = registry.instances.find((item) => item.id === body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    await stopInstance(entry)
    dropUpgradeRoute(entry.id)
    // A sidebar Workspace left over from the in-process era would outlive its project.
    if (entry.workspaceId) {
      try {
        const registryService = hostContext.get ? hostContext.get('workspaceRegistry') : undefined
        if (registryService && typeof registryService.delete === 'function') await registryService.delete(entry.workspaceId)
      } catch { /* the registry is optional now */ }
    }
    // Files are optional: unregistering keeps the checkout and every session log.
    if (body.deleteFiles && entry.stateDir) rmSync(entry.stateDir, { recursive: true, force: true })
    // The profile was scaffolded by the manager too: without it a stale profile lingers.
    rmSync(join(dshHome(), 'profiles', entry.id), { recursive: true, force: true })
    registry.instances = registry.instances.filter((item) => item.id !== entry.id)
    writeRegistry(registry)
    writeJson(res, 200, { removed: true })
  })

  // Restore the projects that were live when the client last quit (delayed so boot stays fast).
  console.log("[dsh-superagent-manager] auto-resume scheduled in 20s")
  let resumeTimer = setTimeout(() => {
    resumeTimer = null
    void autoResume((report) => {
      for (const item of report) {
        if (item.state === 'failed') console.warn('[dsh-superagent-manager] auto-resume failed', item.id, item.error)
      }
    }).catch((error) => {
      console.warn('[dsh-superagent-manager] auto-resume crashed', error)
    })
  }, 20000)
  if (resumeTimer && typeof resumeTimer.unref === 'function') resumeTimer.unref()

  if (typeof ctx.effect === 'function') {
    // Instances are separate processes: quitting the client leaves them running on
    // their own ports, exactly like the standalone `dsh web` they are.
    ctx.effect(() => () => {
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null }
      for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } }
    }, 'dsh-superagent-manager routes')
  }
  return () => { for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } } }
}
