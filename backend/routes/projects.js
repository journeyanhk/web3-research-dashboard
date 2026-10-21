// 项目：身份冲突队列（M2 会在这里扩展项目池接口）
const { Router } = require('express')
const db = require('../lib/db')
const { decideRelation } = require('../lib/identity')

const router = Router()
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[projects]', e.message)
  res.status(500).json({ error: e.message })
})

const projectJson = (alias) => `json_build_object('id', ${alias}.id, 'name', ${alias}.name, 'symbol', ${alias}.symbol,
  'website_domain', ${alias}.website_domain, 'twitter_handle', ${alias}.twitter_handle, 'chains', ${alias}.chains,
  'first_seen_at', ${alias}.first_seen_at, 'merged_into', ${alias}.merged_into)`

router.get('/relations', wrap(async (req, res) => {
  const status = req.query.status || 'possible_duplicate'
  const rows = await db.query(
    `SELECT r.id, r.status, r.reason, r.confidence, r.decided_by, r.created_at, r.decided_at, r.merged_at,
            r.source_project_id, r.target_project_id,
            ${projectJson('a')} AS project_a, ${projectJson('b')} AS project_b
     FROM wr_project_relations r
     JOIN wr_projects a ON a.id = r.project_a
     JOIN wr_projects b ON b.id = r.project_b
     WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [status],
  )
  const counts = await db.query('SELECT status, count(*)::int c FROM wr_project_relations GROUP BY status')
  res.json({ data: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.c])) })
}))

router.post('/relations/:id/decide', wrap(async (req, res) => {
  const decision = req.body?.decision
  if (!['same', 'different'].includes(decision)) return res.status(400).json({ error: 'decision 只能是 same 或 different' })
  res.json(await decideRelation(Number(req.params.id), decision))
}))

module.exports = router
