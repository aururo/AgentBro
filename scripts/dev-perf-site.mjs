// 本地性能测试练习站（开发辅助，不随包发布）。
//
// 目的：让「录制 → 转换 → 冒烟 → 加压 → 报告」能在本机完整走一遍，不依赖任何
// 测试环境。刻意包含四类会让转换器动脑子的东西：
//   1. 登录拿 bearer token（进 setup() 的关联）
//   2. 数值路径参数 /api/orders/1001（产生一条阻断型 TODO，可在面板里绑定/固定/删除）
//   3. 浏览器专属请求头、静态资源、第三方域像素（验证过滤与告警）
//   4. 一次性验证码字段（warn 级 TODO，提醒确认是否固定测试值）
//
// 用法：node scripts/dev-perf-site.mjs [port]
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 0) || 7788
const SESSION_TTL_MS = 30 * 60 * 1000

/** token -> { at } */
const sessions = new Map()
let orderSeq = 1001

function html(body, title = '练习站') {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/static/app.css"></head>
<body>${body}<script src="/static/app.js"></script></body></html>`
}

const loginPage = () =>
  html(
    `<main>
  <h1>登录</h1>
  <p class="hint">练习用账号：<code>qa</code> / <code>qa123</code>，验证码任填 4 位。</p>
  <form id="login">
    <label>账号 <input name="user" value="qa" autocomplete="off"></label>
    <label>密码 <input name="password" type="password" value="qa123"></label>
    <label>验证码 <input name="code" value="1234" maxlength="4"></label>
    <button type="submit">登录</button>
  </form>
  <p id="msg" class="msg"></p>
</main>`,
    '登录 · 练习站',
  )

const ordersPage = () =>
  html(
    `<main>
  <h1>订单列表</h1>
  <p class="hint" id="who"></p>
  <table><thead><tr><th>订单号</th><th>商品</th><th>状态</th><th></th></tr></thead>
  <tbody id="rows"><tr><td colspan="4">加载中…</td></tr></tbody></table>
  <h2>新建订单</h2>
  <form id="create">
    <label>SKU <input name="sku" value="SKU-1001"></label>
    <label>数量 <input name="qty" type="number" value="1" min="1"></label>
    <button type="submit">提交订单</button>
  </form>
  <p id="msg" class="msg"></p>
  <img src="/static/logo.png" width="1" height="1" alt="">
  <img src="http://localhost:${PORT}/track/pixel.gif" width="1" height="1" alt="">
</main>`,
    '订单列表 · 练习站',
  )

const detailPage = (id) =>
  html(
    `<main>
  <h1>订单 ${id}</h1>
  <p id="detail">加载中…</p>
  <p><a href="/orders">返回列表</a></p>
</main>`,
    `订单 ${id} · 练习站`,
  )

const APP_JS = `// 前端逻辑：登录拿 token → 列表 → 详情 → 下单。token 放 sessionStorage 以便刷新。
function tokenOf() { return sessionStorage.getItem('token') || '' }
function authHeaders(extra) {
  return Object.assign({}, extra || {}, tokenOf() ? { authorization: 'Bearer ' + tokenOf() } : {})
}
// 自动流程（?auto=1）：一条链路走完登录→列表→详情→下单，便于一次录制拿到完整 HAR。
// 每一步之间留 700ms，录制时能看清分段标注的落点。
function autoStep(next, delayMs) { setTimeout(function () { location.href = next }, delayMs) }
var AUTO = new URLSearchParams(location.search).get('auto')

document.addEventListener('DOMContentLoaded', function () {
  if (AUTO === '1' && document.getElementById('login')) {
    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'qa', password: 'qa123', code: '1234' }),
    })
      .then(function (res) { return res.json() })
      .then(function (body) {
        sessionStorage.setItem('token', body.data.token)
        setTimeout(function () { location.href = '/orders?auto=1' }, 700)
      })
    return
  }

  var login = document.getElementById('login')
  if (login) {
    login.addEventListener('submit', async function (event) {
      event.preventDefault()
      var form = new FormData(login)
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: form.get('user'), password: form.get('password'), code: form.get('code') }),
      })
      var body = await res.json()
      if (!res.ok) { document.getElementById('msg').textContent = body.message || '登录失败'; return }
      sessionStorage.setItem('token', body.data.token)
      location.href = '/orders'
    })
    return
  }

  var rows = document.getElementById('rows')
  if (rows && AUTO === '1') {
    fetch('/api/orders', { headers: authHeaders() })
      .then(function (res) { return res.json() })
      .then(function () { setTimeout(function () { location.href = '/orders/1001?auto=1' }, 700) })
    return
  }
  if (rows) {
    document.getElementById('who').textContent = '已登录：' + (tokenOf() ? '是' : '否，请先 / 登录')
    fetch('/api/orders', { headers: authHeaders() })
      .then(function (res) { return res.json() })
      .then(function (body) {
        rows.innerHTML = (body.data.items || []).map(function (item) {
          return '<tr><td><a href="/orders/' + item.id + '">' + item.id + '</a></td><td>' + item.sku +
            '</td><td>' + item.status + '</td><td><a href="/orders/' + item.id + '">详情</a></td></tr>'
        }).join('') || '<tr><td colspan="4">还没有订单</td></tr>'
      })
    var create = document.getElementById('create')
    create.addEventListener('submit', async function (event) {
      event.preventDefault()
      var form = new FormData(create)
      var res = await fetch('/api/orders', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ sku: form.get('sku'), qty: Number(form.get('qty')) }),
      })
      var body = await res.json()
      document.getElementById('msg').textContent = res.ok ? '已创建订单 ' + body.data.orderId : (body.message || '失败')
      if (res.ok) setTimeout(function () { location.reload() }, 600)
    })
    return
  }

  var detail = document.getElementById('detail')
  if (detail) {
    var id = location.pathname.split('/').pop()
    var detailJob = fetch('/api/orders/' + id, { headers: authHeaders() })
      .then(function (res) { return res.json() })
      .then(function (body) { detail.textContent = JSON.stringify(body.data) })
    if (AUTO === '1') {
      detailJob.then(function () {
        setTimeout(function () {
          fetch('/api/orders', {
            method: 'POST',
            headers: authHeaders({ 'content-type': 'application/json' }),
            body: JSON.stringify({ sku: 'SKU-AUTO', qty: 1 }),
          }).then(function () { setTimeout(function () { location.href = '/orders' }, 700) })
        }, 700)
      })
    }
  }
})
`

const APP_CSS = `body{font:14px/1.6 system-ui,sans-serif;margin:32px;color:#1f2328}
main{max-width:720px}h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left}
label{display:block;margin:8px 0}.hint{color:#59636e}code{background:#f6f8fa;padding:1px 4px}
input{padding:4px 6px;border:1px solid #d0d7de;border-radius:6px}button{padding:6px 14px;margin-top:8px}
.msg{color:#1a7f37;min-height:20px}`

/** 1×1 透明 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(text)
}

function bearerOf(req) {
  const header = String(req.headers.authorization ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match === null ? '' : match[1].trim()
}

function authorized(req) {
  const token = bearerOf(req)
  if (token !== '' && sessions.has(token)) return true
  // 允许 cookie 鉴权：录制的 HAR 里两条路径都会出现
  const cookie = String(req.headers.cookie ?? '')
  return /(?:^|;\s*)sid=([^;]+)/.test(cookie) && sessions.has(decodeURIComponent(/(?:^|;\s*)sid=([^;]+)/.exec(cookie)[1]))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (path === '/static/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=600' })
    res.end(APP_JS)
    return
  }
  if (path === '/static/app.css') {
    res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=600' })
    res.end(APP_CSS)
    return
  }
  if (path === '/static/logo.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' })
    res.end(PNG_1PX)
    return
  }
  if (path === '/track/pixel.gif') {
    res.writeHead(200, { 'content-type': 'image/gif' })
    res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
    return
  }

  if (path === '/api/login' && req.method === 'POST') {
    const body = await readJson(req)
    if (String(body.user ?? '') !== 'qa' || String(body.password ?? '') !== 'qa123') {
      json(res, 401, { message: '账号或密码不对（练习站固定 qa / qa123）' })
      return
    }
    const token = `tk_${Math.random().toString(36).slice(2, 12)}`
    sessions.set(token, { at: Date.now() })
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `sid=${token}; Path=/; HttpOnly` })
    res.end(JSON.stringify({ data: { token, user: body.user } }))
    return
  }

  if (path === '/api/orders' && req.method === 'GET') {
    if (!authorized(req)) return json(res, 401, { message: '未登录' })
    await delay(8)
    json(res, 200, { data: { items: LIST.slice(), total: LIST.length } })
    return
  }

  if (path === '/api/orders' && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { message: '未登录' })
    const body = await readJson(req)
    await delay(20)
    orderSeq += 1
    const order = { id: orderSeq, sku: String(body.sku ?? 'SKU-?'), status: 'created' }
    LIST.unshift(order)
    json(res, 201, { data: { orderId: order.id } })
    return
  }

  const detail = /^\/api\/orders\/(\d+)$/.exec(path)
  if (detail !== null && req.method === 'GET') {
    if (!authorized(req)) return json(res, 401, { message: '未登录' })
    await delay(10)
    const hit = LIST.find((item) => item.id === Number(detail[1]))
    if (hit === undefined) return json(res, 404, { message: '没有这个订单' })
    json(res, 200, { data: hit })
    return
  }

  if (path === '/' || path === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(loginPage())
    return
  }
  if (path === '/orders') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ordersPage())
    return
  }
  const page = /^\/orders\/(\d+)$/.exec(path)
  if (page !== null) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(detailPage(page[1]))
    return
  }

  json(res, 404, { message: `未知路径 ${path}` })
})

const LIST = [
  { id: 1001, sku: 'SKU-1001', status: 'paid' },
  { id: 1002, sku: 'SKU-1002', status: 'shipped' },
]

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读取请求体并尽力解析 JSON。 */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > 256 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// 会话过期清理：练习站跑很久也不会攒内存。
setInterval(() => {
  const now = Date.now()
  for (const [token, meta] of sessions) if (now - meta.at > SESSION_TTL_MS) sessions.delete(token)
}, 60_000).unref()

server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${PORT}`
  console.log(`练习站已启动：${base}/`)
  console.log('账号 qa / qa123，验证码任填 4 位')
  console.log('')
  console.log('把下面这段贴进 perf/下单主流程 页面（记得改 target 为 test）：')
  console.log('```yaml')
  console.log('perf-spec:')
  console.log('  version: 1')
  console.log('  target: test')
  console.log(`  baseUrl: ${base}`)
  console.log('  loadModel:')
  console.log('    mode: stages')
  console.log('    stages: [{ duration: 30s, target: 2 }, { duration: 1m, target: 5 }, { duration: 30s, target: 0 }]')
  console.log('  thresholds:')
  console.log("    http_req_failed: ['rate<0.01']")
  console.log("    http_req_duration: ['p(95)<500']")
  console.log('```')
  console.log('')
  console.log('建议录制路径：登录 → 列表 → 点第一条详情 → 提交订单（每步点一次「分段标注」）')
})
