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

// 名称歧义队列：多个同名项目、无法自动判断的事件
router.get('/ambiguous-events', wrap(async (_req, res) => {
  const rows = await db.query(
    `SELECT e.id, e.event_type, e.title, e.candidate_name, e.event_at, e.url, e.link_evidence
     FROM wr_events e WHERE e.link_method = 'name_ambiguous' AND e.project_id IS NULL
     ORDER BY e.event_at DESC NULLS LAST LIMIT 100`)
  const ids = [...new Set(rows.flatMap((r) => (r.link_evidence?.candidate_projects || []).map((c) => c.id)))]
  const projects = ids.length
    ? await db.query(
      `SELECT id, name, symbol, chains, website_domain, twitter_handle, surf_project_id, merged_into, first_seen_at
       FROM wr_projects WHERE id = ANY($1)`, [ids])
    : []
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]))
  res.json({
    data: rows.map((r) => ({
      ...r,
      candidates: (r.link_evidence?.candidate_projects || []).map((c) => byId[c.id]).filter((p) => p && !p.merged_into),
    })),
  })
}))

// 人工为事件指定项目（或标记为都不是）
router.post('/events/:id/link', wrap(async (req, res) => {
  const eventId = Number(req.params.id)
  const projectId = req.body?.projectId == null ? null : Number(req.body.projectId)
  const ev = await db.one('SELECT id, link_evidence FROM wr_events WHERE id = $1', [eventId])
  if (!ev) return res.status(404).json({ error: '事件不存在' })
  const evidence = { ...(ev.link_evidence || {}), manual_decision: projectId ? { selected_project: projectId } : { none_of_candidates: true }, decided_at: new Date().toISOString() }
  if (projectId) {
    const p = await db.one('SELECT id FROM wr_projects WHERE id = $1 AND merged_into IS NULL', [projectId])
    if (!p) return res.status(400).json({ error: '项目不存在或已合并' })
    await db.query(
      `UPDATE wr_events SET project_id = $2, link_method = 'manual', link_confidence = 'high', link_evidence = $3 WHERE id = $1`,
      [eventId, projectId, JSON.stringify(evidence)])
  } else {
    await db.query(
      `UPDATE wr_events SET link_method = 'manual_none', link_confidence = 'none', link_evidence = $2 WHERE id = $1`,
      [eventId, JSON.stringify(evidence)])
  }
  res.json({ ok: true })
}))

module.exports = router
