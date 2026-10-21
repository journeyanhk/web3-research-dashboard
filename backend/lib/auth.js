// 访问保护（单人使用）：密码登录 → 签名令牌（30 天）→ 所有业务接口校验 Authorization: Bearer <token>
// 未配置 ADMIN_PASSWORD 时一律拒绝（宁可打不开，也不裸奔）
const crypto = require('node:crypto')
const { getSecret } = require('./config')

const TOKEN_TTL_MS = 30 * 86400000

function signingKey() {
  const explicit = getSecret('AUTH_SECRET')
  if (explicit) return explicit
  // 未单独配置时由密码派生：改密码会让旧令牌全部失效
  return crypto.createHash('sha256').update(`wr-auth|${getSecret('ADMIN_PASSWORD')}`).digest('hex')
}

const b64u = (buf) => Buffer.from(buf).toString('base64url')

function issueToken() {
  const payload = b64u(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, v: 1 }))
  const sig = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest())
  return { token: `${payload}.${sig}`, expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString() }
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false
  const [payload, sig] = token.split('.')
  const expect = b64u(crypto.createHmac('sha256', signingKey()).update(payload).digest())
  const a = Buffer.from(sig || '')
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof exp === 'number' && exp > Date.now()
  } catch { return false }
}

function checkPassword(input) {
  const real = getSecret('ADMIN_PASSWORD')
  if (!real) return false
  const a = crypto.createHash('sha256').update(String(input || '')).digest()
  const b = crypto.createHash('sha256').update(real).digest()
  return crypto.timingSafeEqual(a, b)
}

const passwordConfigured = () => !!getSecret('ADMIN_PASSWORD')

function requireAuth(req, res, next) {
  if (!passwordConfigured()) return res.status(503).json({ error: '未配置登录密码（ADMIN_PASSWORD），接口已锁定', auth_required: true })
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!verifyToken(token)) return res.status(401).json({ error: '请先登录', auth_required: true })
  next()
}

// 登录失败限速：每个 IP 15 分钟内最多 10 次失败
const failures = new Map()
function tooManyFailures(ip) {
  const now = Date.now()
  const list = (failures.get(ip) || []).filter((t) => now - t < 15 * 60000)
  failures.set(ip, list)
  return list.length >= 10
}
function recordFailure(ip) {
  const list = failures.get(ip) || []
  list.push(Date.now())
  failures.set(ip, list)
}

module.exports = { requireAuth, issueToken, verifyToken, checkPassword, passwordConfigured, tooManyFailures, recordFailure }
