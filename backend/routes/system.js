// 系统：数据源、链能力矩阵、点数预算、自检
const { Router } = require('express')
const db = require('../lib/db')
const registry = require('../lib/registry')
const budget = require('../lib/budget')
const { runSelftest } = require('../lib/selftest')

const router = Router()
// 所有接口需要登录（见 lib/auth.js）
router.use(require('../lib/auth').requireAuth)
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[system]', e.message)
  res.status(500).json({ error: e.message })
})

const EDITABLE = new Set(['surf_budget', 'helius_budget', 'coverage_weights', 'robinhood_review_gate', 'discovery_config', 'pipeline_config', 'score_config'])

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
      score_config: require('../lib/scoring').mergeConfig((await registry.getSetting('score_config')) || {}),
      pipeline_config: { ...require('../lib/pipeline').DEFAULT_PIPELINE_CONFIG, ...((await registry.getSetting('pipeline_config')) || {}) },
    },
    scoring: await require('../lib/scoring').scoreOverview(),
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
  if (key === 'score_config') {
    const scoring = require('../lib/scoring')
    const old = await scoring.loadScoreConfig()
    const next = scoring.mergeConfig({ ...old, ...value })
    const sumOk = (w) => Math.abs(Object.values(w || {}).reduce((a, b) => a + Number(b), 0) - 1) <= 0.001
    if (!sumOk(next.quality_weights)) return res.status(400).json({ error: '质量分各维度权重合计需为 1' })
    if (!sumOk(next.tge_weights)) return res.status(400).json({ error: 'TGE 分各维度权重合计需为 1' })
    if (!(next.min_confidence >= 0 && next.min_confidence <= 1)) return res.status(400).json({ error: '最低置信度需在 0–1 之间' })
    if (!(next.robinhood_action_cap >= 0 && next.robinhood_action_cap <= 100)) return res.status(400).json({ error: 'Robinhood 行动分上限需在 0–100 之间' })
    for (const k of ['deep_research', 'watch']) {
      const t = next.thresholds?.[k]
      if (t != null && !(Number(t) >= 0 && Number(t) <= 100)) return res.status(400).json({ error: `阈值 ${k} 需在 0–100 之间或留空` })
    }
    try {
      const { next: saved } = scoring.applyConfigChange(old, next)
      await registry.set('setting', key, saved)
      return res.json({ ok: true, config: saved })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
  }
  if (key === 'pipeline_config') {
    const d = Number(value.dormant_days); const a = Number(value.archive_days)
    const lead = Number(value.lead_archive_days); const mi = Number(value.market_inferred_mcap_usd)
    if (!(d >= 1) || !(a > d)) return res.status(400).json({ error: '休眠天数需 ≥ 1，归档天数需大于休眠天数' })
    if (!(lead >= 1) || lead > d) return res.status(400).json({ error: '线索归档天数需 ≥ 1，且不大于休眠天数' })
    if (!(mi > 0)) return res.status(400).json({ error: '市场推断上市阈值需大于 0' })
  }
  await registry.set('setting', key, value)
  res.json({ ok: true })
}))

// 解锁评分口径：必须填写原因；版本号 +1，下次评分生成新版本快照
router.post('/score-config/unlock', wrap(async (req, res) => {
  const reason = String(req.body?.reason || '').trim()
  if (reason.length < 4) return res.status(400).json({ error: '请填写解锁原因（至少 4 个字）' })
  const scoring = require('../lib/scoring')
  const old = await scoring.loadScoreConfig()
  if (!old.locked) return res.json({ ok: true, already: true, config: old })
  const next = scoring.applyUnlock(old, reason)
  await registry.set('setting', scoring.SCORE_CONFIG_KEY, next)
  res.json({ ok: true, config: next })
}))

let running = null
router.post('/selftest', wrap(async (_req, res) => {
  if (!running) running = runSelftest().finally(() => { running = null })
  res.json(await running)
}))

module.exports = router
