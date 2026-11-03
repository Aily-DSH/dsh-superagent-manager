import { readFileSync, writeFileSync } from 'node:fs'

const file = 'lib/index.js'
let src = readFileSync(file, 'utf8')

const anchor = `      if (!entry || !entry.port) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('super agent is not running'); return }`
if (src.split(anchor).length - 1 !== 1) {
  console.error('anchor not unique'); process.exit(1)
}

const replacement = `      if (!entry || !entry.port) { writeSleepingPage(res, entry); return }
      // A stale port in the registry is common after a restart; probe before proxying so the
      // frame shows a friendly "start it" page instead of a bare 502.
      if (!(await probeState(entry))) { writeSleepingPage(res, entry); return }`

src = src.replace(anchor, replacement)

// handler must be async for the await above
const handlerAnchor = `    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')`
if (src.split(handlerAnchor).length - 1 === 0) {
  // fall back: find the /sa prefix route handler signature
  const alt = `handler: (req, res) => {\n      const url = new URL(req.url ?? '/', 'http://localhost')`
  if (src.split(alt).length - 1 !== 1) { console.error('handler anchor not found'); process.exit(1) }
  src = src.replace(alt, `handler: async (req, res) => {\n      const url = new URL(req.url ?? '/', 'http://localhost')`)
}

// sleeping page helper, inserted before the /sa route registration
const helper = `function writeSleepingPage(res, entry) {
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

`
const routeAnchor = `    kind: 'prefix',`
if (src.split(routeAnchor).length - 1 !== 1) { console.error('route anchor not unique'); process.exit(1) }
src = src.replace(routeAnchor, helper + `    kind: 'prefix',`)

writeFileSync(file, src)
console.log('patched')
