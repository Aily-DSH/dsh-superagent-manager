/**
 * Read-only session mirror.
 *
 * A Super Agent instance is its own dsh process: its conversations live in that
 * process' memory and are appended to `DSH_HOME/sessions/<bucket>/<session>/session.v4.jsonl.zstd`.
 * The host client cannot subscribe to another process, so this module reconstructs a
 * *display* timeline straight from those files.
 *
 * The contract is deliberately narrow and one-directional:
 *   - files are opened read-only, at an offset, and never locked, renamed or created;
 *   - the log is a sequence of concatenated zstd frames, so decoding is incremental by
 *     frame, and an incomplete trailing frame is left for the next poll;
 *   - nothing here can produce a session event, so no input can ever reach an instance.
 *
 * @module dsh-superagent-manager/mirror
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSION_FILE = 'session.v4.jsonl.zstd'
/** Frames are `zstd` magic-prefixed; the writer appends one frame per flush. */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
/** How much of a session is worth reading just to name it in the list. */
const HEAD_BYTES = 64 * 1024
/** Display items kept per session; older ones are dropped and counted. */
const MAX_ITEMS = 4000
const KEEP_ITEMS = 2500
const MAX_TEXT = 8000
/** Reasoning and tool output dominate a transcript; the mirror carries a digest, not a copy. */
const CLIP = { reason: 700, result: 3000, toolArgs: 1200, user: 8000, text: 8000, approval: 1200 }

const files = new Map()

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..' ? value : ''
}

function frameOffsets(buffer, from) {
  const offsets = []
  for (let index = from; index <= buffer.length - 4; index += 1) {
    if (buffer[index] !== MAGIC[0]) continue
    if (buffer[index + 1] !== MAGIC[1] || buffer[index + 2] !== MAGIC[2] || buffer[index + 3] !== MAGIC[3]) continue
    offsets.push(index)
  }
  return offsets
}

/**
 * Decode every complete frame from `buffer` (which starts on a frame boundary).
 * A frame that fails to decode is retried together with its successor: a `28 b5 2f fd`
 * sequence can also occur inside compressed payload, so a "frame" is only real once it
 * decompresses. A trailing frame that still fails is left unconsumed for the next poll.
 */
function decodeFrames(buffer) {
  const offsets = frameOffsets(buffer, 0)
  if (offsets.length === 0) return { text: '', offset: 0, complete: buffer.length === 0 }
  let text = ''
  let index = 0
  while (index < offsets.length) {
    const start = offsets[index]
    let end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    let decoded = null
    let merged = 0
    while (decoded === null && index + 1 + merged < offsets.length) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      } catch {
        merged += 1
        end = index + 1 + merged < offsets.length ? offsets[index + 1 + merged] : buffer.length
      }
    }
    if (decoded !== null) {
      text += decoded
      index += 1 + merged
      continue
    }
    // Last frame of the buffer did not decode: it is still being written.
    return { text, offset: start, complete: false }
  }
  return { text, offset: buffer.length, complete: true }
}

function readRange(file, start, length) {
  if (length <= 0) return Buffer.alloc(0)
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, start)
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'text' && typeof item.text === 'string') out += item.text
  }
  return out
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  const cap = Math.min(typeof max === 'number' ? max : MAX_TEXT, MAX_TEXT)
  return text.length > cap ? text.slice(0, cap) + '\n…（已截断）' : text
}

/**
 * Fold raw session events into the small vocabulary the read-only view renders.
 * Everything that is bookkeeping (step, job, request, delivery, permission knobs) is
 * dropped on purpose: the mirror is for reading what happened, not for replaying it.
 */
function fold(state, events) {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data || {}
    const at = event.time || 0
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string' && data.title) state.title = data.title
        break
      case 'user/message': {
        const text = textOf(data.content)
        if (text.trim()) state.items.push({ k: 'user', text: clip(text, CLIP.user), at })
        break
      }
      case 'assistant/message': {
        const content = data.message && data.message.content
        if (!Array.isArray(content)) break
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            state.items.push({ k: 'text', text: clip(part.text, CLIP.text), at })
          } else if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
            state.items.push({ k: 'reason', text: clip(part.text, CLIP.reason), at })
          }
        }
        break
      }
      case 'tool/call':
        state.items.push({
          k: 'tool',
          name: String(data.name || 'tool'),
          args: clip(String(data.arguments || ''), CLIP.toolArgs),
          at,
        })
        break
      case 'tool/result': {
        const text = textOf(data.content)
        state.items.push({
          k: 'result',
          text: clip(text, CLIP.result),
          isError: Boolean(data.isError),
          at,
        })
        break
      }
      case 'approval/asked':
        state.items.push({
          k: 'approval',
          tool: String(data.toolName || ''),
          reason: clip(String(data.reason || ''), CLIP.approval),
          at,
        })
        break
      case 'approval/decided':
        state.items.push({ k: 'approval-done', at })
        break
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : []
        state.items.push({
          k: 'todo',
          todos: todos.slice(0, 40).map((todo) => ({
            content: clip(String(todo && todo.content ? todo.content : ''), 200),
            status: String((todo && todo.status) || ''),
          })),
          at,
        })
        break
      }
      case 'compaction/summary':
      case 'compaction/start':
        if (event.type === 'compaction/summary') state.items.push({ k: 'note', text: '上下文已压缩（compaction）', at })
        break
      case 'session/end-seed':
        break
      default:
        break
    }
  }
  if (state.items.length > MAX_ITEMS) {
    state.dropped += state.items.length - KEEP_ITEMS
    state.items = state.items.slice(-KEEP_ITEMS)
  }
}

function parseLines(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A half-written line is normal while the instance is appending; skip it.
    }
  }
  return events
}

function sessionFile(root, bucket, session) {
  const safeBucket = safeName(bucket)
  const safeSession = safeName(session)
  if (!safeBucket || !safeSession) return ''
  const file = join(root, safeBucket, safeSession, SESSION_FILE)
  return existsSync(file) ? file : ''
}

/** Header + title, read from the first few frames only. */
function headInfo(file) {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return null
  }
  const buffer = readRange(file, 0, Math.min(size, HEAD_BYTES))
  const { text } = decodeFrames(buffer)
  const events = parseLines(text)
  const header = events.find((event) => event && event.type === 'session') || null
  let title = ''
  let firstUser = ''
  for (const event of events) {
    if (!event) continue
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') title = event.data.title
    if (!firstUser && event.type === 'user/message') firstUser = textOf(event.data && event.data.content)
  }
  return {
    cwd: header && typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: header && header.createdAt ? header.createdAt : 0,
    // A delegated run is a real session file too, but it belongs to its parent's
    // conversation, not to the workspace list. The header carries both facts.
    origin: header && typeof header.origin === 'string' ? header.origin : '',
    parentSession: header && typeof header.parentSession === 'string' ? header.parentSession : '',
    title: title || firstUser.slice(0, 40) || '',
    size,
  }
}

function headCache(file) {
  const cached = files.get('head:' + file)
  let stamp = 0
  try {
    stamp = statSync(file).mtimeMs
  } catch {
    return null
  }
  if (cached && cached.stamp === stamp) return cached.value
  const value = headInfo(file)
  if (value) files.set('head:' + file, { stamp, value })
  return value
}

function bucketFor(cwd) {
  if (!cwd) return ''
  // `C:\Users\x` becomes `--C-Users-x--`: the drive colon is dropped, every separator
  // becomes a dash. Getting this wrong silently hides every session of an instance.
  return '--' + String(cwd).replace(/:/g, '').replace(/[\\/]/g, '-') + '--'
}

function cwdsOf(entry) {
  const list = []
  for (const value of [entry.stateDir, entry.clone, entry.localPath]) {
    if (typeof value === 'string' && value) list.push(value)
  }
  return list
}

/**
 * Every session that belongs to an instance, newest first.
 * Ownership is resolved through the cwd bucket, which is how the store partitions
 * sessions, so no header scan of unrelated sessions is needed.
 */
export function listSessions(root, entry) {
  const out = []
  const seen = new Set()
  for (const cwd of cwdsOf(entry)) {
    const bucket = bucketFor(cwd)
    if (!bucket || seen.has(bucket)) continue
    seen.add(bucket)
    let names = []
    try {
      names = readdirSync(join(root, bucket))
    } catch {
      continue
    }
    for (const session of names) {
      if (!safeName(session)) continue
      const file = sessionFile(root, bucket, session)
      if (!file) continue
      const head = headCache(file)
      let stat = null
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      out.push({
        id: session,
        bucket,
        title: (head && head.title) || session,
        cwd: (head && head.cwd) || cwd,
        createdAt: (head && head.createdAt) || 0,
        updatedAt: stat.mtimeMs,
        bytes: stat.size,
        // Delegated runs live in the same bucket; callers that build a *list* of
        // conversations have to filter them out or the list fills with sub-agent noise.
        origin: (head && head.origin) || '',
        parentSession: (head && head.parentSession) || '',
      })
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/**
 * Read (or continue reading) one session into display items.
 * The returned `total` counts every item ever folded, so the client can tell that it is
 * looking at a tail rather than the whole conversation.
 */
export function readSession(root, entry, session) {
  const names = listSessions(root, entry)
  const found = names.find((item) => item.id === session)
  if (!found) return null
  const file = sessionFile(root, found.bucket, session)
  if (!file) return null
  const key = 'log:' + file
  let state = files.get(key)
  if (!state || !Array.isArray(state.items)) {
    state = { size: 0, offset: 0, items: [], dropped: 0, title: '', header: null }
    files.set(key, state)
  }
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return null
  }
  if (size < state.offset) {
    // Truncated or replaced: start over rather than splicing two different logs.
    state.size = 0
    state.offset = 0
    state.items = []
    state.dropped = 0
  }
  if (size > state.offset) {
    const buffer = readRange(file, state.offset, size - state.offset)
    const decoded = decodeFrames(buffer)
    if (decoded.text) fold(state, parseLines(decoded.text))
    state.offset += decoded.offset
  }
  state.size = size
  return {
    id: session,
    title: state.title || found.title,
    cwd: found.cwd,
    updatedAt: found.updatedAt,
    bytes: size,
    total: state.dropped + state.items.length,
    dropped: state.dropped,
    items: state.items,
  }
}

export function sessionsRoot(home) {
  return join(home, 'sessions')
}

export { isDirectory, bucketFor }
