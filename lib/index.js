import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { connect as netConnect } from 'node:net'
import { createServer as httpCreateServer, request as httpRequest } from 'node:http'
import { listSessions, readSession, sessionsRoot } from './mirror.js'

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
 * Each instance owns its session-log root.
 *
 * Sessions are single-writer kernel locks: two DSH processes sharing `~/.dsh/sessions`
 * cannot open the same conversation, and the loser sees `error.sessionInUse`. Sharing the
 * host home also made every panel list the host's workspaces, so picking a host
 * conversation there failed exactly like that. A per-instance root keeps the instance's own
 * conversations openable and makes cross-process collisions impossible.
 *
 * Set DSH_SUPERAGENT_SHARED_SESSIONS=1 to keep the old shared-store behaviour (and its
 * lock conflicts).
 */
const SHARED_SESSIONS = process.env.DSH_SUPERAGENT_SHARED_SESSIONS === '1'

function instanceSessionsRoot(entry) {
  return join(entry.stateDir, 'sessions')
}

/** `C:\x\y` -> `--C-x-y--`, the bucket name the JSONL backend derives from a cwd. */
function sessionsBucketName(directory) {
  return '--' + String(directory).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '') + '--'
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
    return doc && Array.isArray(doc.instances) ? doc : { instances: [] }
  } catch {
    return { instances: [] }
  }
}

function writeRegistryNow(doc) {
  mkdirSync(managerDir(), { recursive: true })
  doc.revision = (Number(doc.revision) || 0) + 1
  doc.updatedAt = new Date().toISOString()
  const target = registryPath()
  const temporary = target + '.tmp'
  writeFileSync(temporary, JSON.stringify(doc, null, 2) + '\n')
  renameSync(temporary, target)
}

/**
 * Every registry write runs through this queue.
 *
 * Start / stop / create hold the file across a long await (a process may take
 * twenty seconds to die), so a read-modify-write from another route used to write
 * back a snapshot taken before that await: an instance created meanwhile vanished
 * and a colour changed meanwhile reverted. Each mutation now runs against a
 * freshly read document, and long operations only patch their own instance.
 */
let registryQueue = Promise.resolve()

function withRegistry(task) {
  const started = registryQueue.then(task, task)
  registryQueue = started.then(() => undefined, () => undefined)
  return started
}

/** Mutates one instance and nothing else. Returns the patched entry, or null. */
function patchInstance(id, patch) {
  return withRegistry(() => {
    const doc = readRegistry()
    const entry = doc.instances.find((item) => item.id === id)
    if (!entry) return null
    let changed = false
    for (const key of Object.keys(patch)) {
      const value = patch[key]
      if (value === undefined) continue
      if (entry[key] === value) continue
      entry[key] = value
      changed = true
    }
    if (changed) writeRegistryNow(doc)
    return entry
  })
}

/** Appends one instance; null when the id was taken while this request ran. */
function addInstance(entry) {
  return withRegistry(() => {
    const doc = readRegistry()
    if (doc.instances.some((item) => item.id === entry.id)) return null
    doc.instances.push(entry)
    writeRegistryNow(doc)
    return entry
  })
}

/** Removes one instance; returns how many records were dropped. */
function dropInstance(id) {
  return withRegistry(() => {
    const doc = readRegistry()
    const before = doc.instances.length
    doc.instances = doc.instances.filter((item) => item.id !== id)
    if (doc.instances.length === before) return 0
    writeRegistryNow(doc)
    return before - doc.instances.length
  })
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

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i

/** Schemes the desktop shell serves its own UI from. */
const OWN_APP_SCHEME = /^(dsh-app|file):$/i

function parseUrl(value) {
  try { return new URL(String(value)) } catch { return null }
}

/** Loopback, or the app's own non-http origin (`dsh-app://app`, `file:`). */
function isOwnOrigin(value) {
  const parsed = parseUrl(value)
  if (!parsed) return false
  if (LOOPBACK_HOST.test(String(parsed.host || ''))) return true
  return OWN_APP_SCHEME.test(parsed.protocol)
}

/**
 * Binding to loopback keeps the API off the network, but any page open in the same
 * browser can still post to 127.0.0.1 from a cross-origin context, and a DNS
 * rebinding host resolves to loopback while keeping its own name in Host.
 *
 * Two checks carry the weight: a loopback Host (defeats rebinding) and a trusted
 * Origin whenever one is present (defeats cross-origin fetch/XHR).
 *
 * `Sec-Fetch-Site` cannot be a hard gate. The desktop shell serves its own UI from
 * `dsh-app://app`, so the loopback iframe it embeds is *always* `cross-site` by
 * Chromium's definition — that is the shell's architecture, not an attack, and
 * gating on it blanked every Super Agent panel with "cross-site request". The same
 * signal is recovered from `Referer` instead: a frame embedded by a real website
 * sends that site's origin, while the shell sends `dsh-app://` (or nothing).
 *
 * Requests with neither Origin nor Referer (curl, the instance proxy, a top-level
 * navigation) stay allowed: they are local processes, and a bare navigation cannot
 * read the response.
 */
function requestGuard(req) {
  if (!isLocalRequest(req)) return 'local requests only'
  const host = String(req.headers.host || '')
  const hostMatch = LOOPBACK_HOST.exec(host)
  if (!hostMatch) return 'unexpected host: ' + (host || '(none)')
  const origin = req.headers.origin
  if (origin && origin !== 'null') {
    const parsed = parseUrl(origin)
    if (!parsed) return 'unexpected origin'
    // The shell's own page is exempt from the port match: it has no port.
    if (!OWN_APP_SCHEME.test(parsed.protocol)) {
      const originMatch = LOOPBACK_HOST.exec(String(parsed.host || ''))
      if (!originMatch) return 'unexpected origin: ' + origin
      const effectivePort = (match, protocol) => match[2] || (protocol === 'https:' ? '443' : '80')
      if (effectivePort(hostMatch, 'http:') !== effectivePort(originMatch, parsed.protocol)) return 'cross-origin request'
    }
  }
  const referer = req.headers.referer
  if (referer && !isOwnOrigin(referer)) return 'cross-site request'
  return null
}

/** WebSocket upgrades have no CORS: a cross-site page can open one straight at loopback. */
function upgradeGuard(req) {
  if (!isLocalRequest(req)) return 'local requests only'
  const origin = req.headers.origin
  if (!origin || origin === 'null') return null
  return isOwnOrigin(origin) ? null : 'unexpected origin: ' + origin
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
  // The host profile first: it is the one whose bundles the instance copies, so its
  // node_modules is guaranteed to resolve every one of them. Scanning from the top
  // used to land on an unrelated profile that was merely created earlier.
  const host = hostProfileDir()
  if (host && existsSync(join(host, 'node_modules', 'dsh-superagent', 'package.json'))) return host
  try {
    for (const name of readdirSync(join(dshHome(), 'profiles'))) {
      const dir = join(dshHome(), 'profiles', name)
      if (existsSync(join(dir, 'node_modules', 'dsh-superagent', 'package.json'))) return dir
    }
  } catch { /* no profiles */ }
  return ''
}

/**
 * The profile the running host was booted from. The desktop shell passes its profile
 * directory as a positional argv entry; the CLI passes `--profile <name>` instead.
 */
function hostProfileDir() {
  const explicit = process.env.DSH_SUPERAGENT_HOST_PROFILE
  if (explicit && existsSync(explicit)) return explicit
  const args = process.argv.slice(1)
  const resolve = (value) => {
    const direct = existsSync(value) ? value : join(dshHome(), 'profiles', value)
    return existsSync(direct) ? direct : ''
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index])
    if (arg === '--profile' && args[index + 1]) {
      const found = resolve(String(args[index + 1]))
      if (found) return found
    }
    const flag = /^--profile=(.+)$/.exec(arg)
    if (flag) {
      const found = resolve(flag[1])
      if (found) return found
    }
    const positional = /[\\/]profiles[\\/]+([^\\/]+)[\\/]*$/.exec(arg)
    if (positional) {
      const found = join(dshHome(), 'profiles', positional[1])
      if (existsSync(found)) return found
    }
  }
  return ''
}

function bundlesOf(dir) {
  if (!dir) return []
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const list = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : []
  } catch { return [] }
}

/** Bundles that describe the window owning the manager, not an agent you delegate to. */
const HOST_ONLY_BUNDLES = new Set([
  'dsh-superagent-manager',
  'dsh-test-window',
  'dsh-sidebar-tab-close',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
])

const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent']

/**
 * An instance is the same product as the client it is opened from, so it boots the
 * same bundle list. Hardcoding three bundles made every embedded panel a stripped
 * client: no auto-review permission preset, no agent team, no session search, no
 * terminal — the panel looked like a different product on purpose.
 */
function instanceBundles(anchor) {
  const override = process.env.DSH_SUPERAGENT_INSTANCE_BUNDLES
  if (override) return override.split(',').map((item) => item.trim()).filter(Boolean)
  const fromHost = bundlesOf(hostProfileDir())
  const source = fromHost.length ? fromHost : bundlesOf(anchor)
  const list = source.filter((item) => !HOST_ONLY_BUNDLES.has(item))
  for (const required of REQUIRED_BUNDLES) if (!list.includes(required)) list.push(required)
  return list
}

/**
 * Every project owns a tiny profile: its own port, its own state directory, and a
 * junction to the anchor profile's node_modules so nothing needs installing twice.
 */
/**
 * Profile patch for one instance: its port, its orchestrator state, and — unless the old
 * shared store is requested — its own session-log root.
 */
function instancePatch(entry) {
  const lines = [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${entry.port}`,
    '- id: dsh-superagent',
    '  name: dsh-superagent',
    '  config:',
    `    stateDir: '${String(entry.stateDir).replace(/\\/g, '\\\\')}'`,
  ]
  if (!SHARED_SESSIONS) {
    // Forward slashes keep the YAML unambiguous; Windows accepts them in paths.
    lines.push('- id: session-persistence-jsonl', '  config:', `    root: '${instanceSessionsRoot(entry).replace(/\\/g, '/')}'`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Give an instance its own conversations on first start.
 *
 * Before the session root was split, an instance's conversations lived in the host's
 * `sessions/` under the bucket named after its checkout directory. Copying those buckets
 * once keeps the history the user already had visible inside the panel, without writing
 * back into the host store.
 */
function migrateInstanceSessions(entry) {
  if (SHARED_SESSIONS) return { migrated: 0, skipped: 'shared' }
  const target = instanceSessionsRoot(entry)
  const marker = join(target, '.migrated-from-host')
  if (existsSync(marker)) return { migrated: 0 }
  mkdirSync(target, { recursive: true })
  const buckets = new Set()
  for (const directory of [entry.clone, entry.stateDir]) {
    if (!directory) continue
    const bucket = sessionsBucketName(directory)
    if (existsSync(join(dshHome(), 'sessions', bucket))) buckets.add(bucket)
  }
  let migrated = 0
  for (const bucket of buckets) {
    const to = join(target, bucket)
    if (existsSync(to)) continue
    try {
      cpSync(join(dshHome(), 'sessions', bucket), to, { recursive: true })
      migrated += 1
    } catch { /* a missing copy only costs history, never the start */ }
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`)
  return { migrated, buckets: [...buckets] }
}

function ensureProfile(entry) {
  const anchor = anchorProfile()
  if (!anchor) throw new Error('no client profile has dsh-superagent installed')
  const dir = join(dshHome(), 'profiles', entry.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${entry.id}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: instanceBundles(anchor) } },
  }, null, 2) + '\n')
  for (const name of ['cordis.yml', 'pnpm-workspace.yaml']) {
    const from = join(anchor, name)
    if (existsSync(from) && !existsSync(join(dir, name))) writeFileSync(join(dir, name), readFileSync(from))
  }
  writeFileSync(join(dir, 'cordis.patch.yml'), instancePatch(entry))
  const link = join(dir, 'node_modules')
  const target = join(anchor, 'node_modules')
  // Windows stores junctions with a `\\?\` prefix, so compare normalized paths:
  // otherwise every start would rebuild a link that is already correct.
  const normalize = (value) => String(value).replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase()
  let current = ''
  try { current = readlinkSync(link) } catch { current = '' }
  // An instance built while the anchor resolved to the wrong profile still points at a
  // node_modules that cannot resolve the newer bundles; repoint the junction rather
  // than reinstalling anything.
  if (current && normalize(current) !== normalize(target)) {
    try { unlinkSync(link); current = '' } catch { /* keep it; the boot log reports the gap */ }
  }
  if (!existsSync(link)) symlinkSync(target, link, 'junction')
}

/**
 * Bundles the profile would get right now, minus the ones it is actually booting.
 *
 * A profile file is only rewritten on start, so an instance that has been running
 * since before the host installed a plugin keeps booting the old list — and the gap
 * is invisible until a conversation dies on something the host already fixes. The
 * worst case is a context-compression plugin: without it a long panel session hits
 * the model's window limit and every retry, including the compaction request that
 * would have saved it, fails the same way. The panel needs to say "restart me".
 */
function staleBundles(entry) {
  try {
    const anchor = anchorProfile()
    if (!anchor) return null
    const listed = bundlesOf(join(dshHome(), 'profiles', entry.id))
    if (!listed.length) return null
    const wanted = instanceBundles(anchor)
    const missing = wanted.filter((item) => !listed.includes(item))
    // Only a gap the host fills with something new matters. A profile listing MORE than
    // the host (a nested instance, a test profile) is not a stale boot and must not warn.
    return missing.length ? { missing } : null
  } catch {
    return null
  }
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
 * What the OS says about one PID: does it exist, when did it start, what was it
 * launched with.
 *
 * Existence is not identity. A PID recorded before a reboot is reused by whatever
 * Windows spawns next, so terminating it blindly could kill an unrelated program.
 * `queried` separates "the OS answered and has no such process" from "the OS could
 * not be asked at all" — the second case must never be read as "gone".
 */
async function processInfo(pid) {
  if (!pid) return { queried: false, info: null }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue`,
    'if ($p) { $p | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress }',
  ].join('; ')
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 20000 })
  const text = String(result.stdout || '').trim()
  if (!result.ok || !text) return { queried: result.ok, info: null }
  try {
    const info = JSON.parse(text)
    return {
      queried: true,
      info: {
        pid: Number(info.ProcessId) || Number(pid),
        parentPid: Number(info.ParentProcessId) || 0,
        startedAt: info.CreationDate || null,
        commandLine: String(info.CommandLine || ''),
      },
    }
  } catch {
    return { queried: true, info: null }
  }
}

/** True when the command line proves this process is the instance's own dsh. */
function processIsInstance(info, entry) {
  if (!info) return false
  const command = String(info.commandLine || '').replace(/\\/g, '/').toLowerCase()
  if (!command) return false
  const profile = String(entry.id || '').toLowerCase()
  if (profile && command.includes('--profile ' + profile)) return true
  const port = Number(entry.port) || 0
  if (port && command.includes('--port ' + port)) return true
  const stateDir = String(entry.stateDir || '').replace(/\\/g, '/').toLowerCase()
  return Boolean(stateDir) && command.includes(stateDir)
}

/** Compact, displayable summary of who owns the port right now. */
function describeIdentity(inspected) {
  const pick = (list) => list.map((item) => item.pid)
  return {
    verified: pick(inspected.filter((item) => item.queried && item.info && !item.foreign)),
    foreign: pick(inspected.filter((item) => item.queried && item.info && item.foreign)),
    unverified: pick(inspected.filter((item) => !item.info)),
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

/** Eight hex characters of randomness; short enough to read, wide enough not to repeat. */
function shortId(length = 6) {
  const raw = randomBytes(8).toString('hex')
  return raw.slice(0, Math.max(4, Math.min(length, raw.length)))
}

function slug(text) {
  const cleaned = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || `project-${shortId()}`
}

/**
 * A display name and a repository name are different things.
 *
 * "骰子棋旅" and "剑与麦田" both have zero ASCII letters, so deriving the repository
 * from the display name produced "project" for each of them — and because an existing
 * repository was silently reused, the second project pushed its topics into the first
 * project's repository. A name with no usable ASCII stem now gets a random suffix, so
 * every such project maps to a distinct repository by construction.
 */
function repoNameOf(text) {
  const ascii = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7f]/g, '')
  const stem = ascii.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  return stem.length >= 3 ? stem : `project-${shortId()}`
}

/** An explicitly typed repository name: either a valid name, or '' with a reason. */
function explicitRepoName(value) {
  const text = String(value || '').trim()
  if (!text) return { name: '', error: '' }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(text)) return { name: '', error: '仓库名只能用字母、数字、- _ .' }
  if (text === '.' || text === '..') return { name: '', error: '仓库名不能用 . 或 ..' }
  return { name: text, error: '' }
}

class RepoExistsError extends Error {
  constructor(repo, probed) {
    super(`仓库 ${repo} 已存在`)
    this.code = 'repo-exists'
    this.repo = repo
    this.probed = probed
  }
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
 * Does the repository exist? `true` / `false` when GitHub answered, `null` when the
 * question could not be asked (no gh, no network, no permission) — and "could not
 * ask" must never be treated as "does not exist".
 */
async function repoExists(repo) {
  if (!repo) return false
  const probe = await run(ghAgent(), ['api', `repos/${repo}`, '--jq', '.full_name'], { env: await netEnv() })
  if (probe.ok) return true
  const detail = String(probe.stderr || '') + String(probe.error || '')
  if (/404|not found/i.test(detail)) return false
  return null
}

/**
 * Grants admin on a freshly created repository to an operator the caller named.
 *
 * This used to default to a hardcoded personal account: every repository the manager
 * created silently handed admin to that one person, and the result of the invite was
 * never checked. The operator is now explicit (request field or env), and a failed
 * invite is reported instead of swallowed.
 */
async function inviteOperator(repo, viewer, operator) {
  if (!operator || operator === viewer) return null
  const result = await run(ghAgent(), ['api', '-X', 'PUT', `repos/${repo}/collaborators/${operator}`, '-f', 'permission=admin'], { env: await netEnv() })
  if (result.ok) return { login: operator, ok: true }
  return { login: operator, ok: false, error: (result.stderr || result.error || '').trim().slice(0, 300) }
}

/**
 * One project owns one repository, and an existing repository is never reused by
 * accident: two projects whose names collapse to the same ASCII stem would otherwise
 * push their work into one repository without either project noticing. Reuse now
 * requires the caller to say so (`adopt`), which the panel surfaces as an explicit
 * "接入已有仓库" choice.
 */
async function ensureRepository({ owner, repoName, viewer, isPrivate, adopt, operator }) {
  const repo = `${owner}/${repoName}`
  const existing = await repoExists(repo)
  if (existing === true) {
    if (!adopt) throw new RepoExistsError(repo, true)
    const invite = await inviteOperator(repo, viewer, operator)
    return { repo, created: false, adopted: true, invite }
  }
  if (adopt) throw new Error(`仓库 ${repo} 不存在，无法接入`)
  if (existing === null) throw new Error(`无法确认仓库 ${repo} 是否存在：gh 未登录或网络不通，请检查后重试`)
  await gh(['api', '-X', 'POST', viewer && owner === viewer ? 'user/repos' : `orgs/${owner}/repos`, '-f', `name=${repoName}`, '-F', `private=${isPrivate ? 'true' : 'false'}`, '-f', 'description=Managed by dsh-superagent-manager', '--jq', '.full_name'])
  const invite = await inviteOperator(repo, viewer, operator)
  return { repo, created: true, adopted: false, invite }
}

/** Clones the project's repository; the instance process starts afterwards. */
async function scaffold({ name, repo, repoName, owner, managedSlug, localPath }) {
  const id = managedSlug
  const stateDir = join(managerRoot(), id)

  // A project that already lives on disk keeps that folder. Cloning it into the manager's
  // state directory would fork the code and the session history: the sidebar folder, the
  // conversations and the files would all be split between two checkouts of one project.
  if (localPath) {
    if (!existsSync(localPath)) throw new Error(`local project folder does not exist: ${localPath}`)
    return { id, repo, stateDir, cloneDir: localPath, local: true }
  }

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
async function startInstance(entry) {
  if (await probeState(entry)) return { started: true, url: entry.url || '', alreadyRunning: true }
  // Read the registry for a free port instead of trusting a snapshot: another project
  // may have claimed the candidate while this request was waiting.
  if (!instancePort(entry)) entry.port = await pickPort(readRegistry())
  ensureProfile(entry)
  const migrated = migrateInstanceSessions(entry)
  if (migrated.migrated) console.log('[dsh-superagent-manager] imported %d session bucket(s) for %s', migrated.migrated, entry.id)
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
 * Stops the project's process tree and clears the orchestrator lock it leaves behind.
 *
 * A failed health probe is not a stopped instance. probeState() returns null for a
 * crashed instance, a still-booting one, a slow one and a 500 alike, so "the API did
 * not answer" used to be reported as "already stopped" — with the PID cleared and the
 * lock deleted while the process kept serving. Liveness is therefore taken from the
 * TCP listener plus the PID, ownership is verified from the command line before
 * anything is killed, and an instance whose owner cannot be established is reported
 * as unknown instead of stopped.
 */
async function stopInstance(entry) {
  const port = instancePort(entry)
  const listening = port ? await probePort(port) : false
  const recordedAlive = processAlive(entry.pid)
  const candidates = new Set(port ? pidsOnPort(port) : [])
  if (recordedAlive) candidates.add(entry.pid)

  const inspected = []
  for (const pid of candidates) {
    const found = await processInfo(pid)
    inspected.push({ pid, queried: found.queried, info: found.info, foreign: Boolean(found.info) && !processIsInstance(found.info, entry) })
  }
  const identity = describeIdentity(inspected)
  const ours = inspected.filter((item) => item.info && !item.foreign)
  // With no answer from the OS the only identity left is the PID this manager wrote
  // when it spawned the instance. Port listeners are never killed on that basis.
  const recordedUnverified = recordedAlive && !inspected.some((item) => item.pid === entry.pid && item.info)

  if (!listening && !recordedAlive && !ours.length) {
    rmSync(lockPath(entry), { recursive: true, force: true })
    entry.pid = 0
    return { stopped: true, confirmed: true, alreadyStopped: true, targets: [], attempts: [], listening: false, identity }
  }

  const targets = new Set(ours.map((item) => item.pid))
  if (recordedUnverified) targets.add(entry.pid)

  if (!targets.size) {
    return {
      stopped: false,
      confirmed: false,
      alreadyStopped: false,
      reason: identity.foreign.length
        ? `端口 ${port} 被 pid ${identity.foreign.join(', ')} 占用，但它不是本实例的进程`
        : `端口 ${port} 仍在监听，但无法确认占用它的进程属于本实例`,
      targets: [],
      attempts: [],
      listening,
      identity,
    }
  }

  const attempts = []
  for (const pid of targets) attempts.push(await terminatePid(pid))
  let running = true
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250)
    const stillListening = port ? await probePort(port) : false
    const stillAlive = [...targets].some((pid) => processAlive(pid))
    if (!stillListening && !stillAlive) { running = false; break }
  }
  if (running) {
    return {
      stopped: false,
      confirmed: false,
      alreadyStopped: false,
      reason: '进程在终止请求后仍然存活',
      targets: [...targets],
      attempts,
      listening: port ? await probePort(port) : false,
      identity,
    }
  }
  rmSync(lockPath(entry), { recursive: true, force: true })
  entry.pid = 0
  return { stopped: true, confirmed: true, alreadyStopped: false, targets: [...targets], attempts, listening: false, identity }
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
 * Suffix that tells the instance's clone apart from the user's own project folder.
 * Both can be called "SwordAndGrain"; only the path says which is which, and the sidebar
 * shows titles only.
 */
const CLONE_SUFFIX = '（实例克隆）'

/** The workspace registry, or undefined on a profile that does not mount it. */
function workspaceService() {
  // Cordis refuses a plain property read without inject; get() is the supported way.
  try {
    return hostContext && hostContext.get ? hostContext.get('workspaceRegistry') : undefined
  } catch {
    return undefined
  }
}

/** True when the directory is the instance's clone, i.e. inside the manager's state dir. */
function insideStateDir(entry, directory) {
  const state = String((entry && entry.stateDir) || '').toLowerCase().replace(/[\\/]+$/, '')
  const path = String(directory || '').toLowerCase().replace(/[\\/]+$/, '')
  if (!state || !path) return false
  return path === state || path.startsWith(state + '\\') || path.startsWith(state + '/')
}

/**
 * Renames the clone workspace so two same-named folders stop looking identical.
 * Only a workspace that was auto-titled after the instance is touched: a title the user
 * changed by hand is left alone, and a workspace pointing at a real project folder is
 * never renamed. Best effort — the rename is cosmetic.
 */
export async function distinguishCloneTitle(entry, workspace) {
  if (!workspace || typeof workspace.setTitle !== 'function') return false
  if (!insideStateDir(entry, workspace.path)) return false
  const base = String((entry && entry.name) || '')
  if (!base) return false
  if (String(workspace.title || '') !== base) return false
  try {
    await workspace.setTitle(base + CLONE_SUFFIX)
    return true
  } catch {
    return false
  }
}

/**
 * Registers the project's sidebar folder. Best effort: when the workspace service is
 * absent (a headless or stripped profile) the instance still runs on its own port.
 */
async function attachWorkspace(entry) {
  const service = workspaceService()
  // Point the workspace at the project checkout, not the manager's state directory: the
  // checkout is the folder the agent actually edits, and conversations are stored per
  // folder, so this is the one place where the client and the instance see each other's
  // sessions.
  const directory = entry.clone || entry.stateDir
  if (!service || typeof service.create !== 'function' || !directory) return null
  try {
    mkdirSync(directory, { recursive: true })
    const workspace = await service.create(directory, entry.name)
    await distinguishCloneTitle(entry, workspace)
    return workspace && workspace.id ? String(workspace.id) : null
  } catch {
    return null
  }
}

/**
 * Accounts an instance's conversations in its workspace.
 *
 * The instance is a separate process with its own workspace snapshot. A conversation it
 * creates is written to `DSH_HOME/sessions/<bucket>/<id>/` immediately, but stays out of the
 * workspace's `sessionIds` account — so it exists on disk and is invisible everywhere except
 * the instance's own sidebar. This walks the instance's session files and attaches the ones
 * the workspace does not know yet, which is the only way to make them show up in the client.
 *
 * Attaching prepends, so sessions are attached oldest-first to leave the newest at the head.
 * Identity is validated by the workspace itself (canonical cwd must equal the record's path),
 * so a wrong bucket can only fail, never cross-register.
 */
async function syncWorkspaceSessions(entry) {
  const service = workspaceService()
  if (!service || typeof service.create !== 'function') return { ok: false, error: 'workspace registry is not available' }
  const directory = entry.clone || entry.stateDir
  if (!directory) return { ok: false, error: 'instance has no project directory' }
  let workspace = null
  try {
    // create() is idempotent for an existing canonical path, so this also repairs an
    // instance whose workspace registration was lost.
    workspace = await service.create(directory, entry.name)
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
  if (!workspace || typeof workspace.attachSession !== 'function') return { ok: false, error: 'workspace has no session account' }
  // Repairing the title belongs here too: instances created before the suffix existed keep
  // the bare project name forever otherwise, and that is the confusion this fixes.
  const renamed = await distinguishCloneTitle(entry, workspace)

  let known = new Set()
  try { known = new Set(workspace.sessionIds || []) } catch { known = new Set() }
  let sessions = []
  try { sessions = listSessions(sessionsRoot(dshHome()), entry) } catch { sessions = [] }
  // A delegated run is stored in the same bucket as the conversation that spawned it.
  // Attaching one would put "你是审查员…" rows in the user's workspace list, so only
  // top-level conversations are accounted.
  const delegated = sessions.filter((item) => item.parentSession || item.origin === 'subagent').length
  const pending = sessions.filter((item) => item.id && !known.has(item.id) && !item.parentSession && item.origin !== 'subagent')
  const attached = []
  const skipped = []
  for (const item of pending.slice().reverse()) {
    try {
      await workspace.attachSession(item.id)
      attached.push(item.id)
    } catch (error) {
      skipped.push({ id: item.id, error: String(error && error.message ? error.message : error) })
    }
  }
  return {
    ok: true,
    workspaceId: String(workspace.id || ''),
    directory: String(workspace.path || directory),
    title: String(workspace.title || ''),
    renamed,
    scanned: sessions.length,
    delegated,
    attached: attached.length,
    skipped,
    sessionIds: attached,
  }
}

async function describe(entry) {
  const state = await probeState(entry)
  if (state) {
    const tokenUrl = lastTokenUrl(join(entry.stateDir, 'web.log'))
    if (tokenUrl) entry.url = tokenUrl
    // The panel embeds http://127.0.0.1:<proxyPort>/ so the instance keeps storage of its own.
    entry.proxyPort = await ensureOriginProxy(entry)
  }
  return {
    ...entry,
    workspaces: workspacesFor(entry),
    running: Boolean(state),
    // "Should run" and "does run" are two different facts; the panel shows both so a
    // crashed instance never looks like a deliberately stopped one.
    desiredRunning: entry.wasRunning !== false,
    problem: state ? state.problem : null,
    accounts: state ? state.accounts : null,
    load: state ? state.load : null,
    paused: state ? state.paused : null,
    // Present only when the profile file lags the host: the panel turns this into a
    // "restart to pick up the host's plugins" hint instead of silently running without
    // them (context compression is the one users notice).
    staleBundles: staleBundles(entry),
  }
}

/** Absolute path with the platform's own separators; '' when unusable. */
function resolveDir(value) {
  try {
    const text = String(value || '').trim()
    return text ? resolve(text) : ''
  } catch {
    return ''
  }
}

/** Children only: the parent itself is not "inside" itself. */
function isInside(parent, child) {
  const base = resolveDir(parent)
  const target = resolveDir(child)
  if (!base || !target) return false
  const rest = relative(base, target)
  return Boolean(rest) && !rest.startsWith('..') && !isAbsolute(rest)
}

/**
 * Deleting files is only ever allowed for directories this manager created: the
 * instance directory under its own root, and the generated profile folder named
 * after the instance. An operator's own project folder is never inside either.
 */
function ownsManagedPath(path, entry) {
  const target = resolveDir(path)
  if (!target) return false
  if (entry.local && entry.clone && resolveDir(entry.clone) === target) return false
  const profileDir = resolveDir(join(dshHome(), 'profiles', entry.id))
  if (profileDir && target === profileDir) return true
  return isInside(managerRoot(), target)
}

/**
 * The GitHub account that approves the agent's work. It is never defaulted to a
 * person: write access is granted only to an account the caller named.
 */
function operatorOf(body) {
  const explicit = String((body && body.operator) || '').trim()
  const candidate = explicit || String(process.env.SUPERAGENT_MANAGER_OPERATOR || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(candidate) ? candidate : ''
}

/** Owner names reach `gh api repos/<owner>/<repo>`, so they are validated, not trusted. */
function validOwner(value) {
  const text = String(value || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(text) ? text : ''
}

/** Version shown in the panel, so a running page can be traced back to a build. */
const VERSION = '0.3.2'

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
  const targets = readRegistry().instances.filter((entry) => entry.wasRunning !== false)
  const report = []
  for (const entry of targets) {
    try {
      if (await probeState(entry)) { ensureUpgradeRoute(entry); report.push({ id: entry.id, state: 'already-running' }); continue }
      const result = await startInstance(entry)
      // Patch this instance only: a project created or recoloured while the previous
      // one was booting must survive the write.
      await patchInstance(entry.id, { port: entry.port, pid: entry.pid, url: entry.url, wasRunning: true })
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

function proxyToInstance(entry, target, req, res, options) {
  let cookie = ''
  // Only the path-prefixed route rewrites redirects; the dedicated-origin proxy serves
  // the instance at "/" so its Location headers already point at the right place.
  const basePath = (options && options.basePath) || ''
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
      if (responseHeaders.location && basePath) {
        const location = String(responseHeaders.location)
        if (location.startsWith('/')) responseHeaders.location = basePath + location
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

function proxyUpgrade(entry, req, socket, head, targetPath) {
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
      path: targetPath || '/api/remote.mux',
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
 * One dedicated origin per instance.
 *
 * The embedded client keeps its "current session" pointer, workspace view and drafts in
 * origin-scoped localStorage. Serving every instance from the host origin made them share
 * that state with the outer client: the pointer named a session the instance does not own,
 * so the panel opened on "pick a workspace" instead of the agent's own conversation.
 *
 * `<id>.localhost` isolates it as well, but the desktop shell does not resolve those names
 * reliably. A loopback port per instance is an origin it always loads, and still partitions
 * storage.
 */
const originProxies = new Map()
const PROXY_PORT_START = 4310

function currentEntry(id) {
  return readRegistry().instances.find((item) => item.id === id)
}

function proxyPortsInUse(exceptId) {
  const taken = new Set()
  for (const [id, proxy] of originProxies) if (id !== exceptId) taken.add(proxy.port)
  for (const item of readRegistry().instances) {
    if (item.id !== exceptId && item.proxyPort) taken.add(item.proxyPort)
  }
  if (process.env.DSH_SUPERAGENT_PROXY_PORT) taken.add(Number(process.env.DSH_SUPERAGENT_PROXY_PORT))
  return taken
}

/** Binds a loopback proxy for `entry` and returns its port; 0 when nothing could be bound. */
async function ensureOriginProxy(entry) {
  const existing = originProxies.get(entry.id)
  if (existing) {
    entry.proxyPort = existing.port
    return existing.port
  }
  if (!entry.port) return 0

  const taken = proxyPortsInUse(entry.id)
  const candidates = []
  if (entry.proxyPort) candidates.push(entry.proxyPort)
  for (let port = PROXY_PORT_START; port < PROXY_PORT_START + 400; port += 1) {
    if (!taken.has(port)) candidates.push(port)
  }

  for (const port of candidates) {
    const server = httpCreateServer((req, res) => {
      const current = currentEntry(entry.id)
      if (!current || !current.port) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('instance is not running')
        return
      }
      const denied = requestGuard(req)
      if (denied) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end(denied); return }
      proxyToInstance(current, req.url || '/', req, res, { basePath: '' })
    })
    server.on('upgrade', (req, socket, head) => {
      const current = currentEntry(entry.id)
      if (!current || !current.port) { socket.destroy(); return }
      if (upgradeGuard(req)) { socket.destroy(); return }
      proxyUpgrade(current, req, socket, head, req.url || '/api/remote.mux')
    })
    const bound = await new Promise((resolve) => {
      const onError = () => resolve(false)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(true) })
    })
    if (!bound) { try { server.close() } catch {} ; continue }
    server.on('error', () => {})
    originProxies.set(entry.id, { port, server })
    entry.proxyPort = port
    return port
  }
  return 0
}

function dropOriginProxy(id) {
  const proxy = originProxies.get(id)
  if (!proxy) return
  try { proxy.server.close() } catch {}
  originProxies.delete(id)
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
        if (upgradeGuard(req)) { socket.destroy(); return }
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
        const denied = requestGuard(req)
        if (denied) { writeJson(res, 403, { error: denied }); return }
        try {
          await handler(req, res)
        } catch (error) {
          writeJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }))
  }

function writeSleepingPage(res, entry) {
  const name = (entry && (entry.name || entry.id)) || 'super agent'
  const escaped = String(name).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const html = [
    '<!doctype html><meta charset="utf-8">',
    '<div style="font:14px/1.7 system-ui;padding:56px 40px;color:#3a3f4b">',
    '<div style="font-size:18px;font-weight:600;margin-bottom:8px">' + escaped + ' 没在运行</div>',
    '<div style="color:#6b7280">去「设置 → Super Agent 管理」点一下「启动」，再回到这里刷新即可。</div>',
    '</div>',
  ].join('')
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
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
      const denied = requestGuard(req)
      if (denied) { writeJson(res, 403, { error: denied }); return }
      const id = decodeURIComponent(match[1])
      const entry = readRegistry().instances.find((item) => item.id === id)
      if (!entry || !entry.port) { writeSleepingPage(res, entry); return }
      const tail = match[2] && match[2].length ? match[2] : '/'
      // A stale port is common after a restart. Only the document request pays for the probe:
      // probing every asset/api call would double the latency of the whole UI.
      if (tail === '/' && String(req.headers.accept || '').indexOf('text/html') >= 0 && !(await probeState(entry))) {
        writeSleepingPage(res, entry)
        return
      }
      // Serving the page is the first moment we know the instance is wanted;
      // register its realtime upgrade route here so the socket relay is ready.
      ensureUpgradeRoute(entry)
      proxyToInstance(entry, tail + search, req, res, { basePath: '/sa/' + encodeURIComponent(entry.id) })
    },
  }))

  register('/instances', async (req, res) => {
    if ((req.method || 'GET') !== 'GET') { writeJson(res, 405, { error: 'GET only' }); return }
    const registry = readRegistry()
    const instances = []
    // Fields this read is allowed to repair on the stored record. Collected per id and
    // written one instance at a time, so a start or a colour change that landed while
    // the probes were running cannot be rolled back by this snapshot.
    const fixups = new Map()
    const remember = (id, patch) => fixups.set(id, { ...(fixups.get(id) || {}), ...patch })
    for (const entry of registry.instances) {
      // Entries created before colours existed get one on first sight.
      if (!normalizeColor(entry.color)) {
        entry.color = pickColor(null, registry)
        remember(entry.id, { color: entry.color })
      }
      const knownUrl = entry.url
      const described = await describe(entry)
      if (described.running) ensureUpgradeRoute(entry)
      // A workspace the operator created by hand adopts the project on first sight.
      if (!entry.workspaceId && described.workspaces.length) {
        entry.workspaceId = described.workspaces[0]
        described.workspaceId = entry.workspaceId
        remember(entry.id, { workspaceId: entry.workspaceId })
      }
      // describe() re-reads the token the instance printed last; persist it so the
      // panel link keeps working after the instance restarts itself.
      if (entry.url && entry.url !== knownUrl) remember(entry.id, { url: entry.url })
      instances.push(described)
    }
    for (const [id, patch] of fixups) await patchInstance(id, patch)
    const viewer = await agentLogin()
    writeJson(res, 200, {
      viewer,
      version: VERSION,
      template: TEMPLATE_PROFILE,
      instances,
      palette: PALETTE,
      defaults: { operator: String(process.env.SUPERAGENT_MANAGER_OPERATOR || '') },
    })
  })

  /**
   * Resolves everything a creation would do, without doing any of it: the exact
   * owner/repository pair, whether it already exists, the visibility and the local
   * folder. The panel shows this before the operator commits to a repository.
   */
  register('/preview', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const body = await readBody(req)
    const displayName = String(body.name || '').trim()
    if (!displayName) { writeJson(res, 400, { error: 'name is required' }); return }
    const typed = explicitRepoName(body.repoName)
    if (typed.error) { writeJson(res, 400, { error: typed.error }); return }
    const ownerInput = String(body.owner || '').trim()
    if (ownerInput && !validOwner(ownerInput)) { writeJson(res, 400, { error: '仓库归属只能是 GitHub 用户名或组织名' }); return }
    const localPath = String(body.localPath || '').trim()
    const id = `superagent-${slug(displayName)}`
    const viewer = localPath ? '' : await agentLogin()
    const owner = ownerInput || viewer
    const repoName = typed.name || repoNameOf(displayName)
    const repo = owner ? `${owner}/${repoName}` : repoName
    const createRepo = !localPath && body.createRepo !== false
    const exists = createRepo && owner && viewer ? await repoExists(repo) : false
    const taken = readRegistry().instances.some((entry) => entry.id === id || entry.repo === repo)
    writeJson(res, 200, {
      id,
      name: displayName,
      owner,
      repoName,
      repo,
      private: body.private !== false,
      localPath,
      operator: operatorOf(body),
      viewer,
      createRepo,
      exists,
      instanceIdTaken: taken,
      stateDir: join(managerRoot(), id),
    })
  })

  register('/create', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const release = claim('create')
    try {
    const body = await readBody(req)
    const displayName = String(body.name || '').trim()
    if (!displayName) { writeJson(res, 400, { error: 'name is required' }); return }
    // Pointing at an existing folder needs no GitHub at all: the agent adopts the project
    // instead of creating a second copy of it.
    const localPath = String(body.localPath || '').trim()
    if (localPath && !existsSync(localPath)) { writeJson(res, 400, { error: `folder not found: ${localPath}` }); return }
    const typed = explicitRepoName(body.repoName)
    if (typed.error) { writeJson(res, 400, { error: typed.error }); return }
    const ownerInput = String(body.owner || '').trim()
    if (ownerInput && !validOwner(ownerInput)) { writeJson(res, 400, { error: '仓库归属只能是 GitHub 用户名或组织名' }); return }
    const id = `superagent-${slug(displayName)}`
    if (readRegistry().instances.some((entry) => entry.id === id)) { writeJson(res, 409, { error: `instance ${id} already exists` }); return }
    const owner = ownerInput
    // The display name and the repository name are separate on purpose: a name without
    // usable ASCII characters would otherwise map every project onto "project".
    const repoName = typed.name || repoNameOf(displayName)
    const isPrivate = body.private !== false
    const operator = operatorOf(body)

    const viewer = localPath ? '' : await agentLogin()
    if (!localPath && !viewer) { writeJson(res, 409, { error: 'the agent GitHub CLI is not signed in' }); return }

    const createRepo = !localPath && body.createRepo !== false

    // The repository comes first: it is the one artifact a retry must not duplicate.
    let repository = { repo: localPath ? '' : `${owner || viewer}/${repoName}`, created: false, adopted: false, invite: null }
    if (createRepo) {
      try {
        repository = await ensureRepository({ owner: owner || viewer, repoName, viewer, isPrivate, adopt: body.adopt === true, operator })
      } catch (error) {
        if (error && error.code === 'repo-exists') {
          writeJson(res, 409, { code: 'repo-exists', repo: error.repo, error: String(error.message) })
          return
        }
        throw error
      }
    }
    const warnings = []
    if (createRepo && !operator) warnings.push('未指定 operator：GitHub 来源将不接受任何人的指令，请在启动后到实例设置里补上审批人。')
    if (repository.invite && repository.invite.ok === false) warnings.push(`协作者邀请 ${repository.invite.login} 失败：${repository.invite.error}`)

    const created = await scaffold({ name: displayName, repo: repository.repo, repoName, owner: owner || viewer, managedSlug: id, localPath }).catch(async (error) => {
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
      repo: repository.repo || created.cloneDir,
      owner,
      local: Boolean(created.local),
      stateDir: created.stateDir,
      clone: created.cloneDir,
      createdAt: new Date().toISOString(),
      color: pickColor(body.color, readRegistry()),
      workspaceId: null,
    }
    // The sidebar folder is created here, before the process is registered, so the
    // operator sees the project by name instead of hunting for the state directory.
    let workspaceError = null
    entry.workspaceId = await attachWorkspace(entry)
    if (!entry.workspaceId) workspaceError = 'workspace registry is not available'
    // Appended against a freshly read registry: another project created while this one
    // was cloning must not be dropped by this write.
    const stored = await addInstance(entry)
    if (!stored) { writeJson(res, 409, { error: `instance ${id} already exists` }); return }

    const started = await startInstance(entry)
    let configured = null
    let configureError = null
    if (started.started) {
      try {
        configured = await configureInstance(entry, operator)
      } catch (error) {
        configureError = String(error && error.message ? error.message : error)
      }
    }
    await patchInstance(id, { port: entry.port, pid: entry.pid, url: entry.url, wasRunning: started.started, workspaceId: entry.workspaceId })
    writeJson(res, started.started ? 200 : 202, {
      instance: await describe(entry),
      workspace: { directory: entry.clone || entry.stateDir, title: entry.name, port: entry.port, url: entry.url },
      workspaceError,
      warnings,
      repositoryCreated: repository.created,
      repositoryAdopted: Boolean(repository.adopted),
      repository: repository.repo,
      operator,
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
    const entry = currentEntry(body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    const started = await startInstance(entry)
    if (started.started) ensureUpgradeRoute(entry)
    let configureError = null
    if (started.started) {
      try {
        await configureInstance(entry, operatorOf(body))
      } catch (error) {
        configureError = String(error && error.message ? error.message : error)
      }
    }
    await patchInstance(entry.id, {
      port: entry.port,
      pid: entry.pid,
      url: entry.url,
      // Only a confirmed start flips the "should run" flag.
      wasRunning: started.started ? true : entry.wasRunning,
    })
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
    const entry = await patchInstance(String(body.id || ''), { color })
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    writeJson(res, 200, { instance: await describe(entry), palette: PALETTE })
  })

  register('/stop', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const body = await readBody(req)
    const entry = currentEntry(body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    const stopped = await stopInstance(entry)
    // Only a confirmed stop clears the "should run" flag; a failed stop means the
    // instance is still alive and auto-resume must keep opting it in.
    await patchInstance(entry.id, { pid: entry.pid, wasRunning: !stopped.stopped })
    const fresh = currentEntry(entry.id) || entry
    writeJson(res, stopped.stopped ? 200 : 409, { stopped, instance: await describe(fresh) })
  })

  /**
   * Stops, then — only if the stop is confirmed — unregisters and optionally deletes.
   *
   * Removing the record and the files of a process that kept running leaves an orphan
   * on a port with no management entry left to stop it, and no checkout to inspect.
   * So a failed or unconfirmed stop aborts the whole removal with 409, and the files
   * are deleted per directory with each result reported.
   */
  register('/remove', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    const body = await readBody(req)
    const entry = currentEntry(body.id)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }

    const stopped = await stopInstance(entry)
    if (!stopped.stopped) {
      writeJson(res, 409, {
        removed: false,
        error: '停止没有确认，未删除任何文件，记录也保留着：' + (stopped.reason || '无法确认进程已退出'),
        stopped,
        instance: await describe(entry),
      })
      return
    }

    dropUpgradeRoute(entry.id)
    dropOriginProxy(entry.id)

    // A sidebar Workspace left over from the in-process era would outlive its project.
    let workspace = 'none'
    if (entry.workspaceId) {
      try {
        const registryService = hostContext.get ? hostContext.get('workspaceRegistry') : undefined
        if (registryService && typeof registryService.delete === 'function') {
          await registryService.delete(entry.workspaceId)
          workspace = 'deleted'
        } else {
          workspace = 'unavailable'
        }
      } catch {
        workspace = 'failed'
      }
    }

    // Only paths this manager created are candidates, and the profile folder always
    // goes (it is generated). The checkout — and with it every session log and the
    // operator's own files — only goes when the caller asked for it.
    const candidates = [
      { kind: 'profile', path: join(dshHome(), 'profiles', entry.id) },
      { kind: 'state', path: entry.stateDir },
    ].filter((item) => item.path)
    const owned = candidates.filter((item) => ownsManagedPath(item.path, entry))
    const unowned = candidates.filter((item) => !ownsManagedPath(item.path, entry))

    const files = []
    const kept = []
    for (const item of owned) {
      const deleteThis = body.deleteFiles === true || item.kind === 'profile'
      if (!deleteThis) { kept.push(item); continue }
      try {
        rmSync(item.path, { recursive: true, force: true })
        files.push({ ...item, removed: true })
      } catch (error) {
        files.push({ ...item, removed: false, error: String(error && error.message ? error.message : error) })
      }
    }

    const dropped = await dropInstance(entry.id)
    const notes = []
    if (entry.local && entry.clone) notes.push(`本地项目目录 ${entry.clone} 不会删除`)
    if (entry.repo) notes.push(`GitHub 仓库 ${entry.repo} 不会删除`)
    if (kept.some((item) => item.kind === 'state')) notes.push(`${entry.stateDir} 已保留（含日志与克隆）`)
    if (body.deleteFiles === true && unowned.length) notes.push('不在管理器目录内，已跳过：' + unowned.map((item) => item.path).join('、'))
    if (files.some((item) => !item.removed)) notes.push('有目录没有删掉，见 files 字段')

    writeJson(res, 200, { removed: true, dropped: Boolean(dropped), stopped, workspace, files, kept, notes })
  })

  // Account the conversations an instance created in its own process. Without this the
  // session files exist on disk but the workspace list — the only place other views look —
  // never learns about them.
  register('/sync-sessions', async (req, res) => {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST only' }); return }
    let body = null
    try {
      body = await readBody(req)
    } catch {
      writeJson(res, 400, { error: 'body must be JSON' })
      return
    }
    const wanted = body && body.id ? String(body.id) : ''
    const registry = readRegistry()
    const targets = wanted ? registry.instances.filter((item) => item.id === wanted) : registry.instances
    if (!targets.length) { writeJson(res, 404, { error: 'unknown instance' }); return }
    const results = []
    let attached = 0
    for (const entry of targets) {
      let result
      try {
        result = await syncWorkspaceSessions(entry)
      } catch (error) {
        result = { ok: false, error: String(error && error.message ? error.message : error) }
      }
      attached += result.attached || 0
      results.push({ id: entry.id, name: entry.name, ...result })
    }
    writeJson(res, 200, { attached, results })
  })

  // ---- read-only mirror ---------------------------------------------------------
  // A conversation that happens inside an instance belongs to that instance's process.
  // These routes reconstruct a display-only timeline from its session log so the client
  // can *watch* it. They are GET-only on purpose: input stays in the instance.
  register('/mirror/list', async (req, res) => {
    if ((req.method || 'GET') !== 'GET') { writeJson(res, 405, { error: 'GET only' }); return }
    const root = sessionsRoot(dshHome())
    const registry = readRegistry()
    const instances = []
    for (const entry of registry.instances) {
      let sessions = []
      try {
        sessions = listSessions(root, entry).slice(0, 40)
      } catch {
        sessions = []
      }
      instances.push({
        id: entry.id,
        name: entry.name,
        color: entry.color || '',
        url: entry.url || '',
        sessions: sessions.map((item) => ({
          id: item.id,
          title: item.title,
          updatedAt: item.updatedAt,
          bytes: item.bytes,
        })),
      })
    }
    writeJson(res, 200, { readOnly: true, instances })
  })

  register('/mirror/session', async (req, res) => {
    if ((req.method || 'GET') !== 'GET') { writeJson(res, 405, { error: 'GET only' }); return }
    const query = new URL(String(req.url || '/'), 'http://127.0.0.1')
    const instanceId = query.searchParams.get('instance') || ''
    const sessionId = query.searchParams.get('session') || ''
    const limit = Math.max(1, Math.min(Number(query.searchParams.get('limit')) || 200, 500))
    const entry = readRegistry().instances.find((item) => item.id === instanceId)
    if (!entry) { writeJson(res, 404, { error: 'unknown instance' }); return }
    const data = readSession(sessionsRoot(dshHome()), entry, sessionId)
    if (!data) { writeJson(res, 404, { error: 'unknown session' }); return }
    const items = data.items.slice(-limit)
    writeJson(res, 200, {
      readOnly: true,
      id: data.id,
      title: data.title,
      updatedAt: data.updatedAt,
      total: data.total,
      from: data.total - items.length,
      items,
    })
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
  return () => {
    for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } }
    for (const id of [...originProxies.keys()]) dropOriginProxy(id)
  }
}
