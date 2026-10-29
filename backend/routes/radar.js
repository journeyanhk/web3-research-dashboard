// 项目雷达：新发现项目、融资、空投、TGE / 上币、新闻，以及试跑期采集质量
// 注意：M1 只展示「发现」，不展示评分（评分在 M3），避免把新发现误读为推荐
const { Router } = require('express')
const fs = require('node:fs')
const path = require('node:path')
const { Cron } = require('croner')
const db = require('../lib/db')
const registry = require('../lib/registry')
const { identityStatus } = require('../lib/identity')
const { runDiscovery, runIdentityBackfill, isRunning, CORE_CHAINS } = require('../lib/collect/discovery')
const { CHAIN_MISSING_SQL } = require('../lib/projectQuery')

const scheduler = require('../lib/scheduler')

// 路由模块在预览与生产环境都会被加载 → 在这里启动内置调度
scheduler.start()

const router = Router()
// 所有接口需要登录（见 lib/auth.js）
router.use(require('../lib/auth').requireAuth)
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[radar]', e.message)
  res.status(500).json({ error: e.message })
})

const chainParam = (req) => (CORE_CHAINS.includes(req.query.chain) ? req.query.chain : null)

// 下次自动采集时间：以内置调度为准（01:17 UTC 每天）；cron.json 在生产环境可能被平台删除
function nextCronRun() {
  let cronJson = false
  try {
    const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cron.json'), 'utf8'))
    cronJson = tasks.some((x) => x.id === 'discovery-daily' && x.enabled)
  } catch { /* 生产环境可能没有 cron.json */ }
  return { schedule: '17 1 * * *', next_run_at: new Cron('17 1 * * *').nextRun()?.toISOString() || null, cron_json: cronJson, builtin: true }
}

// 事件对应的链：事件自身识别出的链，或关联项目的链
const EVENT_CHAIN_FILTER = `($1::text IS NULL OR e.chains ? $1 OR p.chains ? $1)`

router.get('/overview', wrap(async (req, res) => {
  const chain = chainParam(req)
  // 打开雷达页时顺带检查今天是否该采集（实例休眠时靠访问补跑）；后台执行，不影响页面
  scheduler.ensureDailyRun('visit').catch(() => {})

  const summary = await db.one(
    `SELECT
       count(*) FILTER (WHERE first_seen_at >= date_trunc('day', now()))::int AS new_today,
       count(*) FILTER (WHERE first_seen_at >= now() - interval '7 days')::int AS new_7d,
       count(*)::int AS total,
       count(*) FILTER (WHERE chain_priority = 'core')::int AS core
     FROM wr_projects WHERE merged_into IS NULL AND ($1::text IS NULL OR chains ? $1)`,
    [chain],
  )
  const conflicts = await db.one("SELECT count(*)::int c FROM wr_project_relations WHERE status = 'possible_duplicate'")
  // M2.3 漏斗：按阶段计数 + 「只差确认链」「待验证重点」
  const stageRows = await db.query(
    `SELECT stage, count(*)::int c FROM wr_projects WHERE merged_into IS NULL AND ($1::text IS NULL OR chains ? $1) GROUP BY 1`, [chain])
  const gates = await db.one(
    `SELECT count(*) FILTER (WHERE ${CHAIN_MISSING_SQL})::int AS chain_missing,
            count(*) FILTER (WHERE (p.screening_facts->>'focus') = 'true')::int AS focus,
            count(*) FILTER (WHERE p.identity_status = 'name_only')::int AS name_only
     FROM wr_projects p WHERE p.merged_into IS NULL`)
  const lastBackfill = await db.one(
    `SELECT id, trigger, status, started_at, finished_at, stats, error FROM wr_job_runs WHERE job = 'identity_backfill' ORDER BY id DESC LIMIT 1`)
  const credits = await db.one(
    `SELECT COALESCE(sum(actual_credits),0)::float c FROM wr_api_usage
     WHERE provider = 'surf' AND created_at >= date_trunc('day', now()) AND task LIKE ANY (ARRAY['discovery_%','identity_%'])`,
  )
  const lastRun = await db.one(
    `SELECT id, trigger, status, started_at, finished_at, stats, error FROM wr_job_runs WHERE job = 'discovery' ORDER BY id DESC LIMIT 1`)

  const projects = await db.query(
    `SELECT p.id, p.name, p.symbol, p.chains, p.primary_chain, p.chain_priority, p.discovery_source, p.first_seen_at,
            p.updated_at, p.last_event_at, p.stage, p.coverage_level, p.credits_spent::float AS credits_spent,
            p.tge_status, p.logo_url, p.website_domain, p.twitter_handle, p.surf_project_id,
            (SELECT count(*)::int FROM wr_events e WHERE e.project_id = p.id) AS event_count,
            EXISTS (SELECT 1 FROM wr_project_relations r WHERE r.status = 'possible_duplicate' AND (r.project_a = p.id OR r.project_b = p.id)) AS has_conflict
     FROM wr_projects p
     WHERE p.merged_into IS NULL AND ($1::text IS NULL OR p.chains ? $1)
     ORDER BY p.first_seen_at DESC LIMIT 40`,
    [chain],
  )
  const idStatus = await identityStatus(projects.map((p) => p.id))
  for (const p of projects) p.identity_status = idStatus[p.id] || 'name_only'

  const eventSelect = `SELECT e.id, e.event_type, e.title, e.summary, e.url, e.source_name, e.importance, e.chains,
      e.candidate_name, e.candidate_symbol, e.link_method, e.link_confidence, e.excluded_reason, e.event_at, e.data,
      p.id AS project_id, p.name AS project_name, p.chains AS project_chains
    FROM wr_events e LEFT JOIN wr_projects p ON p.id = e.project_id`

  const fundraising = await db.query(
    `${eventSelect} WHERE e.event_type IN ('fundraising','public_sale') AND e.excluded_reason IS NULL AND ${EVENT_CHAIN_FILTER}
     ORDER BY e.event_at DESC NULLS LAST LIMIT 30`, [chain])
  const airdrops = await db.query(
    `${eventSelect} WHERE e.event_type = 'airdrop' AND e.excluded_reason IS NULL AND ${EVENT_CHAIN_FILTER}
     ORDER BY e.event_at DESC NULLS LAST LIMIT 30`, [chain])
  const listings = await db.query(
    `${eventSelect} WHERE e.event_type = 'listing' AND ($1::text IS NULL OR p.chains ? $1)
     ORDER BY e.event_at DESC NULLS LAST LIMIT 30`, [chain])
  const tge = await db.query(
    `SELECT p.id, p.name, p.symbol, p.chains, p.tge_status, p.tge_exchanges, p.first_seen_at, p.logo_url
     FROM wr_projects p WHERE p.merged_into IS NULL AND p.tge_status IN ('pre','upcoming') AND ($1::text IS NULL OR p.chains ? $1)
     ORDER BY (p.tge_status = 'upcoming') DESC, p.first_seen_at DESC LIMIT 30`, [chain])
  const news = await db.query(
    `${eventSelect} WHERE e.event_type = 'news' AND e.project_id IS NOT NULL AND ($1::text IS NULL OR p.chains ? $1)
     ORDER BY e.event_at DESC NULLS LAST LIMIT 20`, [chain])

  res.json({
    chain,
    summary: { ...summary, open_conflicts: conflicts.c, surf_credits_today: credits.c, ...gates },
    funnel: Object.fromEntries(stageRows.map((r) => [r.stage, r.c])),
    last_run: lastRun, last_backfill: lastBackfill, running: isRunning(), schedule: nextCronRun(), scheduler: scheduler.status(),
    projects, fundraising, airdrops, listings, tge, news,
  })
}))

// 试跑期采集质量（近 7 天）
router.get('/quality', wrap(async (_req, res) => {
  const byType = await db.query(
    `SELECT event_type,
       count(*)::int AS total,
       count(*) FILTER (WHERE excluded_reason IS NOT NULL)::int AS excluded,
       count(*) FILTER (WHERE project_id IS NOT NULL)::int AS linked,
       count(DISTINCT project_id)::int AS projects
     FROM wr_events WHERE created_at >= now() - interval '7 days' GROUP BY 1 ORDER BY 1`)
  const projects = await db.one(
    `SELECT count(*)::int AS created,
       count(*) FILTER (WHERE merged_into IS NOT NULL)::int AS merged_away
     FROM wr_projects WHERE created_at >= now() - interval '7 days'`)
  const rel = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'possible_duplicate')::int AS possible,
            count(*) FILTER (WHERE status = 'confirmed_same')::int AS merged,
            count(*) FILTER (WHERE status = 'confirmed_different')::int AS different
     FROM wr_project_relations WHERE created_at >= now() - interval '7 days'`)
  const idRows = await db.query(
    `SELECT id FROM wr_projects WHERE merged_into IS NULL AND created_at >= now() - interval '7 days'`)
  const ids = await identityStatus(idRows.map((r) => r.id))
  const idDist = { confirmed: 0, partial: 0, name_only: 0 }
  for (const r of idRows) idDist[ids[r.id] || 'name_only']++
  const daily = await db.query(
    `SELECT to_char(date_trunc('day', created_at),'MM-DD') AS day,
       COALESCE(sum(actual_credits),0)::float AS actual, COALESCE(sum(estimated_credits) FILTER (WHERE status='ok'),0)::float AS estimated,
       count(*) FILTER (WHERE status='cached')::int AS cached, count(*)::int AS calls,
       count(*) FILTER (WHERE status='error')::int AS errors
     FROM wr_api_usage WHERE provider = 'surf' AND created_at >= now() - interval '7 days'
       AND task LIKE ANY (ARRAY['discovery_%','identity_%'])
     GROUP BY 1 ORDER BY 1`)
  const providerFail = await db.query(
    `SELECT provider, count(*)::int AS calls, count(*) FILTER (WHERE status='error')::int AS errors
     FROM wr_api_usage WHERE created_at >= now() - interval '7 days' AND status <> 'cached' GROUP BY 1`)
  const runs = await db.query(
    `SELECT id, trigger, status, started_at, finished_at, stats->>'surf_credits' AS credits, instance, stats->>'note' AS note
     FROM wr_job_runs WHERE job = 'discovery' ORDER BY id DESC LIMIT 10`)
  // 每 100 点产出的初筛项目：近 7 天新发现、目前处于初筛及之后阶段（不含淘汰）的项目数 / 近 7 天采集点数 × 100
  const screened = await db.one(
    `SELECT count(*)::int c FROM wr_projects WHERE merged_into IS NULL AND first_seen_at >= now() - interval '7 days'
       AND stage IN ('screening','deep_research','watch','tge_plan','tge_exec','holding')`)
  const credits7d = daily.reduce((a, d) => a + Number(d.actual || 0), 0)
  const funnel = await db.query(
    `SELECT stage, count(*)::int c FROM wr_projects WHERE merged_into IS NULL GROUP BY 1`)
  res.json({
    byType, projects, relations: rel, identity: idDist, daily, providerFail, runs,
    screening: { projects: screened.c, credits: credits7d, per_100: credits7d ? +(screened.c / credits7d * 100).toFixed(1) : null },
    funnel: Object.fromEntries(funnel.map((f) => [f.stage, f.c])),
  })
}))

router.post('/run', wrap(async (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: '采集正在进行中，请稍后' })
  const r = await runDiscovery({ trigger: 'manual' })
  res.json(r)
}))

// 一次性身份补全（M2.3）：对只有名称的项目各搜一次 Surf。dryRun=true 只返回候选数和预计点数，不花点数
router.post('/identity-backfill', wrap(async (req, res) => {
  if (isRunning()) return res.status(409).json({ error: '采集正在进行中，请稍后' })
  const r = await runIdentityBackfill({ limit: Number(req.body?.limit) || 30, dryRun: !!req.body?.dryRun })
  res.json(r)
}))

router.get('/config', wrap(async (_req, res) => {
  const { DEFAULT_CONFIG } = require('../lib/collect/discovery')
  res.json({ ...DEFAULT_CONFIG, ...((await registry.getSetting('discovery_config')) || {}) })
}))

module.exports = router
