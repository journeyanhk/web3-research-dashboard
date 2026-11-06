// 站内提醒（M2.3.2 轻量版）：列表、标记已处理、手动扫描
const { Router } = require('express')
const db = require('../lib/db')
const { scanEventAlerts } = require('../lib/notify')

const router = Router()
router.use(require('../lib/auth').requireAuth)
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next)

const TYPES = {
  entered_screening: { label: '进入初筛', severity: 'high' },
  new_funding: { label: '新融资', severity: 'normal' },
  new_public_sale: { label: '新公募', severity: 'normal' },
  new_listing: { label: '新上币', severity: 'normal' },
  tge_signal: { label: 'TGE 信号', severity: 'high' },
  reactivated: { label: '重新激活', severity: 'normal' },
  archive_due: { label: '即将归档', severity: 'normal' },
  archived: { label: '已归档', severity: 'low' },
}

router.get('/', wrap(async (req, res) => {
  const status = ['open', 'resolved', 'dismissed', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'open'
  const limit = Math.min(Number(req.query.limit) || 100, 300)
  const cat = req.query.category ? String(req.query.category) : null
  const params = []
  const where = []
  if (status !== 'all') { params.push(status); where.push(`a.status = $${params.length}`) }
  if (cat) { params.push(cat); where.push(`a.category = $${params.length}`) }
  params.push(limit)
  const rows = await db.query(
    `SELECT a.id, a.project_id, a.category, a.alert_type, a.severity, a.title, a.detail, a.status, a.created_at, a.resolved_at,
            p.name AS project_name, p.stage AS project_stage
       FROM wr_alerts a LEFT JOIN wr_projects p ON p.id = a.project_id
      WHERE ${where.length ? where.join(' AND ') : 'true'}
      ORDER BY a.status = 'open' DESC, a.id DESC
      LIMIT $${params.length}`, params)
  const counts = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'open' AND category = 'signal')::int AS signal,
            count(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS critical,
            count(*)::int AS total
       FROM wr_alerts`)
  res.json({ data: rows, counts, types: TYPES })
}))

router.post('/:id(\\d+)/resolve', wrap(async (req, res) => {
  const status = req.body?.status === 'dismissed' ? 'dismissed' : 'resolved'
  const r = await db.one(
    `UPDATE wr_alerts SET status = $2, resolved_at = now() WHERE id = $1 RETURNING id, status`, [Number(req.params.id), status])
  if (!r) return res.status(404).json({ error: '提醒不存在' })
  res.json(r)
}))

router.post('/resolve-all', wrap(async (req, res) => {
  const cat = req.body?.category ? String(req.body.category) : null
  const rows = await db.query(
    `UPDATE wr_alerts SET status = 'resolved', resolved_at = now() WHERE status = 'open' ${cat ? 'AND category = $1' : ''} RETURNING id`,
    cat ? [cat] : [])
  res.json({ resolved: rows.length })
}))

router.post('/scan', wrap(async (_req, res) => {
  res.json(await scanEventAlerts({ sinceHours: 26 }))
}))

module.exports = router
