// 轻量站内提醒（M2.3.2）：TGE / 上币 / 新融资等事件型提醒，去重后写入 wr_alerts。
// 阶段型提醒（进入初筛、归档、重新激活、即将归档）在 pipeline.evaluateProjects 里直接写入。
const db = require('./db')
const { raiseAlert } = require('./alerts')

const MAX_PER_RUN = 40 // 单次最多生成的提醒条数，避免刷屏
const EVENT_TYPES = ['fundraising', 'public_sale', 'listing', 'tge']

const EVENT_ALERT = {
  fundraising: { type: 'new_funding', label: '新融资' },
  public_sale: { type: 'new_public_sale', label: '新公募' },
  listing: { type: 'new_listing', label: '新上币' },
  tge: { type: 'tge_signal', label: 'TGE 信号' },
}

function moneyText(v) {
  const n = Number(v || 0)
  if (!n) return null
  if (n >= 1e8) return `$${(n / 1e8).toFixed(1)} 亿`
  if (n >= 1e4) return `$${(n / 1e4).toFixed(0)} 万`
  return `$${n}`
}

/**
 * 扫描最近 N 小时新关联的事件，生成事件型提醒（去重键 event:<id>）。
 * 只提醒中 / 高置信度关联的事件；低置信度（仅凭符号）不打扰。
 */
async function scanEventAlerts({ sinceHours = 26 } = {}) {
  const rows = await db.query(
    `SELECT e.id, e.project_id, e.event_type, e.title, e.link_confidence, e.importance, e.data, e.event_at,
            p.name AS project_name, p.stage
       FROM wr_events e
       JOIN wr_projects p ON p.id = e.project_id AND p.merged_into IS NULL
      WHERE e.created_at > now() - ($1::int || ' hours')::interval
        AND e.excluded_reason IS NULL
        AND e.event_type = ANY($2::text[])
        AND COALESCE(e.link_confidence, 'medium') IN ('high', 'medium')
        AND COALESCE(e.importance, 2) >= 2
      ORDER BY e.id DESC
      LIMIT $3`,
    [sinceHours, EVENT_TYPES, MAX_PER_RUN],
  )
  let created = 0
  for (const e of rows) {
    const meta = EVENT_ALERT[e.event_type]
    if (!meta) continue
    const d = e.data || {}
    if (e.event_type === 'tge' && !['upcoming', 'post'].includes(d.status)) continue
    if (e.event_type === 'listing' && d.pre_market === true) continue
    const amount = moneyText(d.amount_usd || d.raise_amount_usd || d.total_raise)
    const round = d.round || d.round_name || null
    const exch = Array.isArray(d.exchanges) ? d.exchanges.filter(Boolean).slice(0, 4) : []
    const bits = [amount && `金额 ${amount}`, round, exch.length ? `${exch.join(' / ')}` : null].filter(Boolean)
    const dedupeKey = `event:${e.id}`
    const exist = await db.one('SELECT id FROM wr_alerts WHERE dedupe_key = $1', [dedupeKey])
    if (exist) continue
    await raiseAlert({
      category: 'signal', type: meta.type, severity: 'info', projectId: e.project_id,
      title: `${meta.label}：${e.project_name}${bits.length ? `（${bits.join('，')}）` : ''}`,
      detail: { event_id: e.id, event_type: e.event_type, confidence: e.link_confidence, event_at: e.event_at, title: e.title, stage: e.stage },
      dedupeKey,
    })
    created++
  }
  return { scanned: rows.length, created }
}

module.exports = { scanEventAlerts, EVENT_ALERT }
