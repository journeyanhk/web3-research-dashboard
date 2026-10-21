// 项目：身份冲突队列（M2 会在这里扩展项目池接口）
const { Router } = require('express')
const db = require('../lib/db')
const { decideRelation } = require('../lib/identity')
const pipeline = require('../lib/pipeline')
const { listProjects, FRESHNESS_SQL } = require('../lib/projectQuery')

const router = Router()
// 所有接口需要登录（见 lib/auth.js）
router.use(require('../lib/auth').requireAuth)
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
  const rel = await db.one('SELECT project_a, project_b FROM wr_project_relations WHERE id = $1', [Number(req.params.id)])
  const r = await decideRelation(Number(req.params.id), decision)
  // 冲突处理后重新评估相关项目（数据冲突状态会自动解除）
  if (rel) await pipeline.evaluateProjects([rel.project_a, rel.project_b].filter(Boolean))
  res.json(r)
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
    await pipeline.evaluateProjects([projectId])
  } else {
    await db.query(
      `UPDATE wr_events SET link_method = 'manual_none', link_confidence = 'none', link_evidence = $2 WHERE id = $1`,
      [eventId, JSON.stringify(evidence)])
  }
  res.json({ ok: true })
}))

// ───────── 项目池（M2）─────────

router.get('/meta', wrap(async (_req, res) => {
  res.json({ stages: pipeline.STAGES, completeness: pipeline.COMPLETENESS_ITEMS })
}))

router.get('/', wrap(async (req, res) => {
  const result = await listProjects(req.query)
  const signals = await db.query(
    `SELECT signal_label, count(*)::int c FROM wr_projects WHERE merged_into IS NULL AND signal_label IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)
  res.json({ ...result, signals })
}))

router.post('/evaluate', wrap(async (_req, res) => {
  res.json(await pipeline.evaluateProjects())
}))

router.get('/:id(\\d+)', wrap(async (req, res) => {
  const id = Number(req.params.id)
  const p = await db.one(
    `SELECT p.*, lm.last_metric_at, p.detail_fetched_at AS last_detail_at, ${FRESHNESS_SQL} AS freshness
     FROM wr_projects p
     LEFT JOIN LATERAL (SELECT max(fetched_at) AS last_metric_at FROM wr_metrics m WHERE m.project_id = p.id) lm ON true
     WHERE p.id = $1`, [id])
  if (!p) return res.status(404).json({ error: '项目不存在' })
  if (p.merged_into) return res.json({ redirect: p.merged_into })
  const [identifiers, events, metrics, credits, relations, history, notes, ambiguous] = await Promise.all([
    db.query('SELECT id_type, id_value, source, created_at FROM wr_project_ids WHERE project_id = $1 ORDER BY id_type, created_at', [id]),
    db.query(
      `SELECT id, event_type, title, summary, url, source_name, importance, chains, candidate_name, link_method, link_confidence,
              link_evidence, excluded_reason, event_at, data
       FROM wr_events WHERE project_id = $1 ORDER BY event_at DESC NULLS LAST LIMIT 200`, [id]),
    db.query(
      `SELECT DISTINCT ON (metric_name) metric_name, value::float AS value, unit, source, primary_source, fallback_used,
              fallback_reason, confidence::float AS confidence, observed_at, fetched_at
       FROM wr_metrics WHERE project_id = $1 ORDER BY metric_name, fetched_at DESC`, [id]),
    db.query(
      `SELECT provider, COALESCE(task,'—') AS task, count(*)::int AS calls,
              COALESCE(sum(actual_credits),0)::float AS credits, count(*) FILTER (WHERE status='cached')::int AS cached
       FROM wr_api_usage WHERE project_id = $1 GROUP BY 1,2 ORDER BY credits DESC`, [id]),
    db.query(
      `SELECT r.id, r.status, r.reason, r.confidence, r.decided_by, r.created_at, r.merged_at, r.evidence,
              CASE WHEN r.project_a = $1 THEN r.project_b ELSE r.project_a END AS other_id,
              o.name AS other_name, o.website_domain AS other_domain, o.twitter_handle AS other_twitter, o.chains AS other_chains
       FROM wr_project_relations r
       JOIN wr_projects o ON o.id = CASE WHEN r.project_a = $1 THEN r.project_b ELSE r.project_a END
       WHERE r.project_a = $1 OR r.project_b = $1 ORDER BY r.created_at DESC`, [id]),
    db.query('SELECT id, from_stage, to_stage, source, reason, operator, rule_version, created_at FROM wr_stage_history WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    db.query('SELECT id, body, created_at, updated_at FROM wr_notes WHERE project_id = $1 ORDER BY created_at DESC', [id]),
    db.query(
      `SELECT id, event_type, title, event_at FROM wr_events
       WHERE link_method = 'name_ambiguous' AND project_id IS NULL AND link_evidence->'candidate_projects' @> $1::jsonb`,
      [JSON.stringify([{ id }])]),
  ])
  res.json({ project: p, identifiers, events, metrics, credits, relations, history, notes, ambiguous })
}))

router.post('/:id(\\d+)/stage', wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (req.body?.mode === 'auto') return res.json(await pipeline.restoreAuto(id))
  await pipeline.setStageManual(id, String(req.body?.stage || ''), req.body?.reason)
  res.json({ ok: true })
}))

router.post('/:id(\\d+)/notes', wrap(async (req, res) => {
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: '备注不能为空' })
  const p = await db.one('SELECT id FROM wr_projects WHERE id = $1 AND merged_into IS NULL', [Number(req.params.id)])
  if (!p) return res.status(404).json({ error: '项目不存在' })
  const r = await db.one('INSERT INTO wr_notes (project_id, body) VALUES ($1, $2) RETURNING *', [p.id, body])
  res.json(r)
}))

router.put('/notes/:noteId(\\d+)', wrap(async (req, res) => {
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: '备注不能为空' })
  const r = await db.one('UPDATE wr_notes SET body = $2, updated_at = now() WHERE id = $1 RETURNING *', [Number(req.params.noteId), body])
  if (!r) return res.status(404).json({ error: '备注不存在' })
  res.json(r)
}))

router.delete('/notes/:noteId(\\d+)', wrap(async (req, res) => {
  await db.query('DELETE FROM wr_notes WHERE id = $1', [Number(req.params.noteId)])
  res.json({ ok: true })
}))

module.exports = router
