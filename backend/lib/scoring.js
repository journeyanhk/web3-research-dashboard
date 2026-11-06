// M3 全自动评分（框架版）
// 说明：维度、证据结构、版本、置信度、覆盖率、历史快照、红旗、Robinhood 复核门槛都已实现；
// 权重 / 阈值 / 折扣先按「草案」运行，等观察 1–2 天真实数据后再由人工锁定。
const crypto = require('crypto')
const db = require('./db')
const registry = require('./registry')
const pipeline = require('./pipeline')

const SCORE_VERSION = 'm3.0-draft'
const SCORING_RULE_VERSION = 'm3-scoring-0'
const SCORE_CONFIG_KEY = 'score_config'
const SCORE_SNAPSHOT_TYPES = pipeline.SNAPSHOT_TYPES

// 权重合计为 1；运行时仍会归一化，避免手动改配置后总分漂移。
const DEFAULT_SCORE_CONFIG = {
  version: SCORE_VERSION,
  locked: false, // false = 草案口径，结论只作参考
  quality_weights: { funding: 0.22, product: 0.2, traction: 0.13, chain: 0.15, evidence: 0.2, momentum: 0.1 },
  tge_weights: { token_plan: 0.35, funding: 0.2, community: 0.2, listing: 0.15, momentum: 0.1 },
  // 链数据覆盖折扣：只作用于行动分，不改「质量分」本身的含义
  chain_factor: { ethereum: 1, bsc: 1, base: 1, arbitrum: 1, solana: 0.9, robinhood: 0.8 },
  market_inferred_factor: 0.85, // 仅有市值推断上市：质量分打折，避免把「可能已上市」当早期项目
  lead_factor: 0.6, // 只有名称的线索
  stale_days: 30,
  min_confidence: 0.45, // 低于该置信度不给行动建议（待锁定）
  robinhood_action_cap: 60, // Robinhood Chain 行动分上限（待锁定，需人工复核）
  thresholds: { deep_research: null, watch: null }, // null = 未锁定，不产出「建议深研 / 关注」结论
}

const DIM_LABEL = { funding: '融资质量', product: '产品与链上', traction: '社区热度', chain: '链归属', evidence: '证据强度', momentum: '近期动能' }
const TGE_DIM_LABEL = { token_plan: '代币计划', funding: '融资背景', community: '社区基础', listing: '上市线索', momentum: '时间窗口' }
const GRADE_LABEL = { A: 'A（强）', B: 'B（较好）', C: 'C（一般）', D: 'D（弱）' }
const FLAG_LABEL = {
  lead: ['仅名称线索', 'warn'],
  market_inferred: ['可能已上市（未确认）', 'warn'],
  chain_inferred: ['链为文字推断', 'warn'],
  chain_missing: ['缺所属链', 'warn'],
  airdrop_chain_only: ['链仅来自空投任务', 'risk'],
  no_funding: ['无融资记录', 'info'],
  no_product: ['无产品 / 链上证据', 'info'],
  stale_data: ['数据超过时效', 'warn'],
  robinhood_review: ['Robinhood 需人工复核', 'risk'],
  conflict: ['身份冲突', 'risk'],
  listed: ['已上市', 'info'],
  out_of_scope: ['不在早期池', 'info'],
  low_confidence: ['置信度不足', 'warn'],
}
const RECOMMENDATION_LABEL = {
  pending_thresholds: '口径待锁定',
  deep_research: '建议深研',
  watch: '纳入观察',
  skip: '暂不跟进',
  insufficient_data: '数据不足',
  lead_only: '线索（不评分决策）',
  inactive: '已休眠 / 归档',
  out_of_scope: '不在早期池',
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const round1 = (v) => Math.round(v * 10) / 10
const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v))
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null)

function mergeConfig(saved = {}) {
  const cfg = { ...DEFAULT_SCORE_CONFIG, ...saved }
  for (const k of ['quality_weights', 'tge_weights', 'chain_factor', 'thresholds']) {
    cfg[k] = { ...DEFAULT_SCORE_CONFIG[k], ...(saved[k] || {}) }
  }
  return cfg
}

async function loadScoreConfig() {
  return mergeConfig((await registry.getSetting(SCORE_CONFIG_KEY)) || {})
}

const configHash = (cfg) => crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 16)

// 归一化权重（缺项按 0 处理，避免出现 NaN）
function weighted(dims, weights) {
  let sum = 0
  let wsum = 0
  for (const [k, w] of Object.entries(weights)) {
    const v = Number(dims[k])
    if (!Number.isFinite(v)) continue
    sum += v * num(w)
    wsum += num(w)
  }
  return wsum > 0 ? sum / wsum : 0
}

function fundingDim(extras) {
  const amount = num(extras.maxFundingUsd)
  const rounds = num(extras.fundingRounds)
  let v = amount >= 50e6 ? 95 : amount >= 20e6 ? 85 : amount >= 5e6 ? 72 : amount >= 1e6 ? 58 : amount > 0 ? 45 : rounds > 0 ? 35 : 20
  v += Math.min(rounds, 3) * 3 + (extras.publicSale ? 4 : 0)
  return clamp(v)
}

function productDim(f, extras) {
  const tvl = num(f.metrics?.tvl_usd)
  if (f.productLevel === 'high') {
    const bonus = tvl >= 100e6 ? 15 : tvl >= 10e6 ? 10 : tvl >= 1e6 ? 6 : tvl > 0 ? 3 : 0
    return clamp(80 + bonus)
  }
  if (f.productLevel === 'low') return 38
  return extras.hasContract ? 62 : extras.airdropTask ? 22 : 10
}

function tractionDim(f) {
  const tf = num(f.metrics?.twitter_followers)
  let v = tf >= 1e6 ? 95 : tf >= 500e3 ? 88 : tf >= 100e3 ? 74 : tf >= 10e3 ? 58 : tf >= 1e3 ? 40 : tf > 0 ? 26 : 15
  if (num(f.metrics?.tvl_usd) > 0) v += 6
  return clamp(v)
}

function chainDim(f) {
  return { core_confirmed: 95, other_confirmed: 55, inferred: 30, none: 15 }[f.chainStatus] ?? 15
}

function evidenceDim(f, groups) {
  const g = groups.length
  const base = g >= 4 ? 90 : g === 3 ? 78 : g === 2 ? 60 : g === 1 ? 32 : 10
  const done = Object.values(f.completeness || {}).filter(Boolean).length / (pipeline.COMPLETENESS_ITEMS.length || 1)
  return clamp(base + done * 10)
}

function momentumDim(extras) {
  const fundingDays = daysSince(extras.lastFundingAt)
  const eventDays = daysSince(extras.lastEventAt)
  if (fundingDays != null && fundingDays <= 30) return 82
  if (eventDays != null && eventDays <= 30) return num(extras.recentEvents) >= 3 ? 78 : 60
  if (fundingDays != null && fundingDays <= 90) return 62
  return 30
}

function tgeDim(f, extras) {
  const status = f.project.tge_status || extras.tgeStatus || null
  const plan = f.hard?.token_plan ? 55 : 20
  const statusBoost = status === 'upcoming' ? 35 : status === 'pre' ? 22 : 0
  const saleBoost = extras.publicSale ? 12 : 0
  const tokenPlan = clamp(plan + statusBoost + saleBoost)
  const listing = clamp(extras.listingEvents > 0 ? Math.min(100, 55 + extras.listingEvents * 12) : 20)
  const community = tractionDim(f)
  const momentum = momentumDim(extras)
  return { token_plan: tokenPlan, funding: fundingDim(extras), community, listing, momentum }
}

function buildFlags(f, extras, opts) {
  const flags = []
  const add = (code) => { if (!flags.some((x) => x.code === code)) flags.push({ code, label: FLAG_LABEL[code][0], level: FLAG_LABEL[code][1] }) }
  if (f.lead) add('lead')
  if (f.listingLevel === 'market_inferred') add('market_inferred')
  if (f.chainStatus === 'inferred') add('chain_inferred')
  if (f.chainStatus === 'none') add('chain_missing')
  if (f.chainSource === 'airdrop_task') add('airdrop_chain_only')
  if (!extras.fundingRounds && !extras.publicSale) add('no_funding')
  if (!f.productLevel && !extras.hasContract) add('no_product')
  if (opts.freshnessDays != null && opts.freshnessDays > opts.staleDays) add('stale_data')
  if ((f.chains || []).includes('robinhood')) add('robinhood_review')
  if (f.conflict) add('conflict')
  if (['confirmed', 'market_inferred'].includes(f.listingLevel)) add('listed')
  if (['listed_watch', 'non_early', 'opportunity_chain'].includes(f.project.stage)) add('out_of_scope')
  if (opts.confidence < opts.minConfidence) add('low_confidence')
  return flags
}

/** 纯函数：根据筛选事实 + 评分补充数据算出一条评分（可单测） */
function scoreFacts(f, extras = {}, cfg = DEFAULT_SCORE_CONFIG) {
  const groups = [...new Set(Object.values(f.origins || {}).flatMap((s) => [...s]))]
  const completeness = Object.values(f.completeness || {}).filter(Boolean).length / (pipeline.COMPLETENESS_ITEMS.length || 1)
  const identityFactor = f.identity === 'confirmed' ? 1 : f.identity === 'partial' ? 0.7 : 0.3
  const groupFactor = Math.min(groups.length, 4) / 4
  const freshnessDays = daysSince(f.dataAsOf)
  const freshnessFactor = freshnessDays == null ? 0.2 : freshnessDays <= 7 ? 1 : freshnessDays <= 30 ? 0.8 : freshnessDays <= 90 ? 0.5 : 0.3
  const confidence = round1((0.2 * identityFactor + 0.3 * groupFactor + 0.25 * completeness + 0.25 * freshnessFactor) * 100) / 100

  const dims = {
    funding: fundingDim(extras),
    product: productDim(f, extras),
    traction: tractionDim(f),
    chain: chainDim(f),
    evidence: evidenceDim(f, groups),
    momentum: momentumDim(extras),
  }
  let quality = weighted(dims, cfg.quality_weights)
  if (f.listingLevel === 'market_inferred') quality *= num(cfg.market_inferred_factor) || 1
  if (f.lead) quality *= num(cfg.lead_factor) || 1
  quality = round1(clamp(quality))

  // 链数据覆盖：多条链时取覆盖最好的那条，避免重复打折
  const factors = (f.chains || []).map((c) => num(cfg.chain_factor?.[c] || 1)).filter((v) => v > 0)
  const coverage = factors.length ? Math.min(1, Math.max(...factors)) : 0.6

  const listedConfirmed = f.listingLevel === 'confirmed' || f.project.tge_status === 'post'
  const tgeDims = listedConfirmed ? {} : tgeDim(f, extras)
  const tgeScore = listedConfirmed ? null : round1(clamp(weighted(tgeDims, cfg.tge_weights)))

  const outOfScope = ['listed_watch', 'non_early', 'opportunity_chain'].includes(f.project.stage)
  const inactive = ['dormant', 'archived'].includes(f.project.stage)
  const actionable = !f.lead && !outOfScope && !inactive && confidence >= num(cfg.min_confidence) && f.chainStatus !== 'none'
  let actionScore = null
  if (actionable) {
    actionScore = round1(clamp(quality * (0.55 + 0.45 * confidence) * coverage))
    if ((f.chains || []).includes('robinhood')) actionScore = Math.min(actionScore, num(cfg.robinhood_action_cap) || 100)
  }

  let recommendation = 'pending_thresholds'
  if (f.lead) recommendation = 'lead_only'
  else if (inactive) recommendation = 'inactive'
  else if (outOfScope) recommendation = 'out_of_scope'
  else if (confidence < num(cfg.min_confidence)) recommendation = 'insufficient_data'
  else if (cfg.thresholds?.deep_research != null || cfg.thresholds?.watch != null) {
    const q = actionScore ?? quality
    recommendation = cfg.thresholds.deep_research != null && q >= num(cfg.thresholds.deep_research) ? 'deep_research'
      : cfg.thresholds.watch != null && q >= num(cfg.thresholds.watch) ? 'watch'
        : 'skip'
  }

  const flags = buildFlags(f, extras, { freshnessDays, staleDays: num(cfg.stale_days) || 30, confidence, minConfidence: num(cfg.min_confidence) })
  const grade = quality >= 80 ? 'A' : quality >= 65 ? 'B' : quality >= 50 ? 'C' : 'D'

  const reasons = []
  reasons.push(extras.fundingRounds
    ? `融资：${extras.fundingRounds} 轮，最高单轮 ${extras.maxFundingUsd ? `$${(num(extras.maxFundingUsd) / 1e6).toFixed(1)}M` : '金额未披露'}`
    : '融资：暂无中高置信融资记录')
  reasons.push(f.productLevel === 'high'
    ? `产品：有合约 / TVL 证据${num(f.metrics?.tvl_usd) > 0 ? `（TVL $${(num(f.metrics.tvl_usd) / 1e6).toFixed(1)}M）` : ''}`
    : f.productLevel === 'low' ? '产品：只有空投任务，未验证真实产品' : '产品：暂无产品证据')
  reasons.push(`链：${(f.chains || []).join(', ') || '未知'}（${pipeline.CHAIN_STATUS_LABEL[f.chainStatus] || f.chainStatus}）`)
  reasons.push(`证据：${groups.length} 个独立来源，完整度 ${Math.round(completeness * 100)}%`)
  reasons.push(freshnessDays == null ? '数据：没有可用的时间戳' : `数据：${freshnessDays} 天前更新`)
  if (f.lead) reasons.push('身份只有名称，评分仅供线索排序，不进入正式结论')
  if (f.listingLevel === 'market_inferred') reasons.push('市值推断已上市但未确认，质量分已打折')

  return {
    quality_score: quality,
    tge_score: tgeScore,
    action_score: actionScore,
    grade,
    confidence,
    coverage: round1(coverage * 100) / 100,
    freshness_days: freshnessDays,
    recommendation,
    dims,
    tge_dims: tgeDims,
    flags,
    reasons,
    groups: groups.length,
    completeness: Math.round(completeness * 100) / 100,
  }
}

// 评分补充数据：融资金额 / 轮次、上市事件、TGE 状态、合约、近期事件
async function loadExtras(ids) {
  if (!ids.length) return {}
  const events = await db.query(
    `SELECT project_id, event_type, link_confidence, importance, data, created_at, excluded_reason
     FROM wr_events WHERE project_id = ANY($1)`, [ids])
  const idsRows = await db.query(
    `SELECT project_id, bool_or(id_type = 'contract') AS has_contract FROM wr_project_ids WHERE project_id = ANY($1) GROUP BY 1`, [ids])
  const contractSet = new Set(idsRows.filter((r) => r.has_contract).map((r) => r.project_id))
  const out = {}
  for (const id of ids) out[id] = { fundingRounds: 0, maxFundingUsd: 0, publicSale: false, listingEvents: 0, tgeStatus: null, recentEvents: 0, lastEventAt: null, lastFundingAt: null, airdropTask: false, hasContract: contractSet.has(id) }
  for (const e of events) {
    const x = out[e.project_id]
    if (!x || e.excluded_reason) continue
    const t = new Date(e.created_at).getTime()
    if (!x.lastEventAt || t > new Date(x.lastEventAt).getTime()) x.lastEventAt = e.created_at
    if (t >= Date.now() - 30 * 86400000) x.recentEvents += 1
    if (e.event_type === 'airdrop') x.airdropTask = true
    const trusted = ['high', 'medium'].includes(e.link_confidence || 'medium')
    if (!trusted) continue
    if (['fundraising', 'public_sale'].includes(e.event_type)) {
      x.fundingRounds += 1
      x.publicSale = x.publicSale || e.event_type === 'public_sale'
      const amount = num(String(e.data?.amount_usd ?? '').replace(/[^0-9.]/g, ''))
      if (amount > x.maxFundingUsd) x.maxFundingUsd = amount
      if (!x.lastFundingAt || t > new Date(x.lastFundingAt).getTime()) x.lastFundingAt = e.created_at
    }
    if (e.event_type === 'listing') x.listingEvents += 1
    if (e.event_type === 'tge' && e.data?.status) x.tgeStatus = e.data.status
  }
  return out
}

const scoreHash = (result, cfgHash) => crypto.createHash('sha1').update(JSON.stringify({
  v: SCORE_VERSION, cfg: cfgHash, q: result.quality_score, t: result.tge_score, a: result.action_score,
  c: result.confidence, cov: result.coverage, f: result.flags.map((x) => x.code), r: result.recommendation,
})).digest('hex')

/** 批量评分：写最新分到项目表，口径 / 结果变化时追加历史快照 */
async function scoreProjects(ids = null, { snapshotType = 'historical_runtime' } = {}) {
  if (!SCORE_SNAPSHOT_TYPES.includes(snapshotType)) throw new Error(`未知快照类型：${snapshotType}`)
  const cfg = await loadScoreConfig()
  const cfgHash = configHash(cfg)
  const targetIds = ids?.length ? ids.map(Number) : (await db.query('SELECT id FROM wr_projects WHERE merged_into IS NULL')).map((r) => r.id)
  const changed = []
  let snapshots = 0
  for (let i = 0; i < targetIds.length; i += 200) {
    const chunk = targetIds.slice(i, i + 200)
    const [facts, extras] = await Promise.all([pipeline.gatherFacts(chunk), loadExtras(chunk)])
    const lastRows = await db.query(
      `SELECT DISTINCT ON (project_id) project_id, facts_hash, config_hash, score_version
       FROM wr_scores WHERE project_id = ANY($1) ORDER BY project_id, created_at DESC, id DESC`, [chunk])
    const last = Object.fromEntries(lastRows.map((r) => [r.project_id, r]))
    for (const f of facts) {
      const p = f.project
      if (p.merged_into) continue
      const result = scoreFacts(f, extras[p.id] || {}, cfg)
      // facts_hash 字段复用为「本次评分的完整指纹」，便于判断结果是否真的变化
      const hash = scoreHash(result, cfgHash)
      await db.query(
        `UPDATE wr_projects SET quality_score = $2, tge_score = $3, action_score = $4, score_grade = $5,
           score_confidence = $6, score_version = $7, scored_at = now() WHERE id = $1`,
        [p.id, result.quality_score, result.tge_score, result.action_score, result.grade,
          result.confidence, SCORE_VERSION],
      )
      const prev = last[p.id]
      if (prev && prev.facts_hash === hash && prev.config_hash === cfgHash && prev.score_version === SCORE_VERSION) continue
      await db.query(
        `INSERT INTO wr_scores (project_id, score_version, scoring_rule_version, quality_score, tge_score, action_score,
           grade, confidence, coverage, freshness_days, recommendation, dims, tge_dims, flags, reasons,
           facts_hash, config_hash, snapshot_type, data_as_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [p.id, SCORE_VERSION, SCORING_RULE_VERSION, result.quality_score, result.tge_score, result.action_score,
          result.grade, result.confidence, result.coverage, result.freshness_days, result.recommendation,
          JSON.stringify(result.dims), JSON.stringify(result.tge_dims), JSON.stringify(result.flags),
          JSON.stringify(result.reasons), hash, cfgHash, snapshotType, f.dataAsOf || null],
      )
      snapshots += 1
      changed.push({ id: p.id, name: p.name, quality: result.quality_score, tge: result.tge_score, action: result.action_score, recommendation: result.recommendation })
    }
  }
  return { version: SCORE_VERSION, rule_version: SCORING_RULE_VERSION, config_hash: cfgHash, locked: !!cfg.locked, scored: targetIds.length, changed, snapshots }
}

async function scoreOverview() {
  const rows = await db.query(
    `SELECT count(*)::int AS scored,
            count(*) FILTER (WHERE quality_score IS NOT NULL)::int AS with_quality,
            avg(quality_score)::float AS avg_quality,
            count(*) FILTER (WHERE score_grade = 'A')::int AS grade_a,
            count(*) FILTER (WHERE score_grade = 'B')::int AS grade_b,
            count(*) FILTER (WHERE score_grade = 'C')::int AS grade_c,
            count(*) FILTER (WHERE score_grade = 'D')::int AS grade_d,
            count(*) FILTER (WHERE action_score IS NOT NULL)::int AS actionable,
            max(scored_at) AS last_scored_at
     FROM wr_projects WHERE merged_into IS NULL AND score_version IS NOT NULL`)
  return rows[0] || {}
}

// 供前端 / 自检使用的默认阈值说明（数值本身不锁定）
const SCORE_NOTE = '评分口径为草案：权重、阈值、折扣需观察 1–2 天真实数据后人工锁定；未锁定时不下「建议深研 / 关注」结论。'

module.exports = {
  SCORE_VERSION, SCORING_RULE_VERSION, SCORE_CONFIG_KEY, SCORE_SNAPSHOT_TYPES, SCORE_NOTE,
  DEFAULT_SCORE_CONFIG, DIM_LABEL, TGE_DIM_LABEL, GRADE_LABEL, FLAG_LABEL, RECOMMENDATION_LABEL,
  mergeConfig, loadScoreConfig, configHash, scoreFacts, scoreProjects, scoreOverview, loadExtras,
}
