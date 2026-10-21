// 系统：数据源、链能力矩阵、点数预算、自检
const { Router } = require('express')
const db = require('../lib/db')
const registry = require('../lib/registry')
const budget = require('../lib/budget')
const { runSelftest } = require('../lib/selftest')

const router = Router()
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[system]', e.message)
  res.status(500).json({ error: e.message })
})

const EDITABLE = new Set(['surf_budget', 'helius_budget', 'coverage_weights', 'robinhood_review_gate', 'discovery_config'])

router.get('/overview', wrap(async (_req, res) => {
  await registry.ensureSeeded()
  const [chains, providers, weights, gate, lastSelftest, surf, helius] = await Promise.all([
    registry.list('chain'), registry.list('provider'), registry.getSetting('coverage_weights'),
    registry.getSetting('robinhood_review_gate'), registry.getSetting('last_selftest'),
    budget.surfStatus(), budget.heliusStatus(),
  ])
  const stats = await db.query(`
    SELECT provider,
      count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS calls_today,
      count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS calls_7d,
      count(*) FILTER (WHERE status = 'cached' AND created_at >= now() - interval '7 days')::int AS cached_7d,
      count(*) FILTER (WHERE status = 'error' AND created_at >= now() - interval '7 days')::int AS errors_7d,
      count(*) FILTER (WHERE status = 'blocked' AND created_at >= now() - interval '7 days')::int AS blocked_7d,
      COALESCE(sum(rate_limited) FILTER (WHERE created_at >= now() - interval '7 days'),0)::int AS rate_limited_7d,
      COALESCE(avg(duration_ms) FILTER (WHERE status = 'ok' AND created_at >= now() - interval '7 days'),0)::int AS avg_ms_7d,
      COALESCE(sum(actual_credits) FILTER (WHERE created_at >= date_trunc('month', now())),0)::float AS credits_month
    FROM wr_api_usage GROUP BY provider`)
  const byTask = await db.query(`
    SELECT COALESCE(task,'—') AS task, trigger, COALESCE(sum(actual_credits),0)::float AS credits, count(*)::int AS calls
    FROM wr_api_usage WHERE provider = 'surf' AND created_at >= date_trunc('month', now())
    GROUP BY 1,2 ORDER BY credits DESC LIMIT 20`)
  const daily = await db.query(`
    SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day, provider, COALESCE(sum(actual_credits),0)::float AS credits
    FROM wr_api_usage WHERE created_at >= now() - interval '30 days' GROUP BY 1,2 ORDER BY 1`)
  // 按接口统计（近 7 天）：缓存命中率、预估 vs 实际成本
  const byEndpoint = await db.query(`
    SELECT provider, endpoint,
      count(*)::int AS calls,
      count(*) FILTER (WHERE status = 'cached')::int AS cached,
      count(*) FILTER (WHERE status = 'ok')::int AS ok,
      count(*) FILTER (WHERE status = 'error')::int AS errors,
      COALESCE(sum(estimated_credits) FILTER (WHERE status = 'ok'),0)::float AS est_credits,
      COALESCE(sum(actual_credits) FILTER (WHERE status = 'ok'),0)::float AS actual_credits
    FROM wr_api_usage WHERE created_at >= now() - interval '7 days'
    GROUP BY 1,2 ORDER BY calls DESC LIMIT 40`)
  const openAlerts = await db.one("SELECT count(*)::int c FROM wr_alerts WHERE status = 'open'")
  const projects = await db.one('SELECT count(*)::int c FROM wr_projects')

  res.json({
    chains: chains.sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ ...c, ...registry.chainCoverage(c, weights) })),
    providers: providers.map((p) => ({ ...p, stats: stats.find((s) => s.provider === p.key) || null })),
    budget: { surf, helius, byTask, daily, byEndpoint },
    settings: {
      surf_budget: await registry.getSetting('surf_budget'),
      helius_budget: await registry.getSetting('helius_budget'),
      coverage_weights: weights, robinhood_review_gate: gate,
      score_version: await registry.getSetting('score_version'),
    },
    counts: { open_alerts: openAlerts.c, projects: projects.c },
    last_selftest: lastSelftest,
  })
}))

router.get('/usage', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const provider = req.query.provider || null
  const rows = await db.query(
    `SELECT id, provider, endpoint, params, trigger, task, status, http_status, actual_credits::float AS credits,
            estimated_credits::float AS estimated_credits, duration_ms, attempts,
            rate_limited, error, raw_id, created_at
     FROM wr_api_usage WHERE ($1::text IS NULL OR provider = $1) ORDER BY id DESC LIMIT $2`,
    [provider, limit],
  )
  res.json({ data: rows })
}))

router.put('/settings/:key', wrap(async (req, res) => {
  const { key } = req.params
  if (!EDITABLE.has(key)) return res.status(400).json({ error: '该配置不可修改' })
  const value = req.body?.value
  if (!value || typeof value !== 'object') return res.status(400).json({ error: '配置格式错误' })
  if (key === 'surf_budget') {
    if (!(value.monthly > 0) || !(value.auto_ratio > 0 && value.auto_ratio <= 1)) return res.status(400).json({ error: '月预算需大于 0，自动比例需在 0–1 之间' })
  }
  if (key === 'coverage_weights') {
    const sum = Object.values(value).reduce((a, b) => a + Number(b), 0)
    if (Math.abs(sum - 1) > 0.001) return res.status(400).json({ error: `权重合计需为 1（当前 ${sum.toFixed(2)}）` })
  }
  await registry.set('setting', key, value)
  res.json({ ok: true })
}))

let running = null
router.post('/selftest', wrap(async (_req, res) => {
  if (!running) running = runSelftest().finally(() => { running = null })
  res.json(await running)
}))

module.exports = router
