// 项目池列表查询：显式生成占位符，避免与 PostgreSQL 的 jsonb `?` 运算符冲突（M2.1 修复）
const db = require('./db')

const SORTS = {
  first_seen: 'p.first_seen_at DESC, p.id DESC',
  last_event: 'p.last_event_at DESC NULLS LAST, p.id DESC',
  completeness: 'p.completeness DESC NULLS LAST, p.first_seen_at DESC',
  credits: 'p.credits_spent DESC, p.first_seen_at DESC',
  stage_changed: 'p.stage_changed_at DESC NULLS LAST, p.id DESC',
}

function buildWhere(query, { includeStage }) {
  const where = ['p.merged_into IS NULL']
  const params = []
  // builder 接收本参数的占位符（如 $3），同一个值可以在 SQL 中多次使用同一个占位符
  const addParam = (builder, value) => {
    params.push(value)
    where.push(builder(`$${params.length}`))
  }
  const { chain, source, identity, signal, q, chain_priority: chainPriority, stage } = query
  if (chain) addParam((p) => `p.chains ? ${p}`, String(chain))
  if (chainPriority) addParam((p) => `p.chain_priority = ${p}`, String(chainPriority))
  if (source) addParam((p) => `p.source_types ? ${p}`, String(source))
  if (identity) addParam((p) => `p.identity_status = ${p}`, String(identity))
  if (signal) addParam((p) => `p.signal_label = ${p}`, String(signal))
  if (q && String(q).trim()) {
    addParam((p) => `(p.name ILIKE ${p} OR p.symbol ILIKE ${p} OR p.website_domain ILIKE ${p} OR p.twitter_handle ILIKE ${p})`,
      `%${String(q).trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
  }
  if (includeStage && stage) addParam((p) => `p.stage = ${p}`, String(stage))
  return { sql: where.join(' AND '), params }
}

// 数据新鲜度：取「最近事件 / 最近详情 / 最近指标」中最新的一个
const FRESHNESS_SQL = `
  CASE
    WHEN p.stage = 'data_conflict' THEN 'conflict'
    WHEN GREATEST(p.last_event_at, p.detail_fetched_at, lm.last_metric_at) >= now() - interval '7 days' THEN 'fresh'
    WHEN GREATEST(p.last_event_at, p.detail_fetched_at, lm.last_metric_at) >= now() - interval '30 days' THEN 'stale'
    ELSE 'expired'
  END`

async function listProjects(query = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200)
  const offset = Math.max(Number(query.offset) || 0, 0)
  const order = SORTS[query.sort] || SORTS.first_seen

  // 阶段计数：应用除阶段外的全部筛选（用于漏斗页签）
  const base = buildWhere(query, { includeStage: false })
  const stageCounts = await db.query(`SELECT p.stage, count(*)::int c FROM wr_projects p WHERE ${base.sql} GROUP BY 1`, base.params)

  const full = buildWhere(query, { includeStage: true })
  const total = await db.one(`SELECT count(*)::int c FROM wr_projects p WHERE ${full.sql}`, full.params)
  const n = full.params.length
  const rows = await db.query(
    `SELECT p.id, p.name, p.symbol, p.chains, p.chain_priority, p.stage, p.stage_source, p.stage_reason, p.stage_changed_at,
            p.identity_status, p.source_types, p.signal_label, p.completeness::float AS completeness, p.tge_status,
            p.credits_spent::float AS credits_spent, p.first_seen_at, p.last_event_at, p.website_domain, p.twitter_handle,
            p.discovery_source, p.review_status, p.detail_fetched_at AS last_detail_at, lm.last_metric_at,
            ${FRESHNESS_SQL} AS freshness,
            (SELECT count(*)::int FROM wr_events e WHERE e.project_id = p.id) AS event_count,
            (SELECT count(*)::int FROM wr_notes nt WHERE nt.project_id = p.id) AS note_count
     FROM wr_projects p
     LEFT JOIN LATERAL (SELECT max(fetched_at) AS last_metric_at FROM wr_metrics m WHERE m.project_id = p.id) lm ON true
     WHERE ${full.sql} ORDER BY ${order} LIMIT $${n + 1} OFFSET $${n + 2}`,
    [...full.params, limit, offset],
  )
  return {
    data: rows, total: total.c, limit, offset,
    stage_counts: Object.fromEntries(stageCounts.map((r) => [r.stage, r.c])),
  }
}

module.exports = { listProjects, buildWhere, FRESHNESS_SQL }
