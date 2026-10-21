// 登录
const { Router } = require('express')
const auth = require('../lib/auth')

const router = Router()

router.post('/login', (req, res) => {
  if (!auth.passwordConfigured()) return res.status(503).json({ error: '未配置登录密码（ADMIN_PASSWORD）' })
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim()
  if (auth.tooManyFailures(ip)) return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' })
  if (!auth.checkPassword(req.body?.password)) {
    auth.recordFailure(ip)
    return res.status(401).json({ error: '密码错误' })
  }
  res.json(auth.issueToken())
})

router.get('/me', auth.requireAuth, (_req, res) => res.json({ ok: true }))

module.exports = router
