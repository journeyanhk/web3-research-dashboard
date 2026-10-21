// M2 项目漏斗：阶段定义、自动评估（初筛硬条件 + 加分条件）、信号标签、资料完整度
//
// 自动评估只作用于「自动区」阶段（发现 / 待验证 / 数据待补全 / 数据冲突 / 初筛），且项目阶段来源为 auto；
// 人工设定过阶段的项目（stage_source = manual），自动规则只刷新派生字段，不改阶段。
// M2 不做评分；进入深度尽调等后续阶段目前只能人工设定（M3 评分后再加自动升级）。
const db = require('./db')
const { identityStatus } = require('./identity')

const STAGES = [
  { id: 'discovered', label: '发现', auto: true },
  { id: 'pending_verify', label: '待验证', auto: true },
  { id: 'data_incomplete', label: '数据待补全', auto: true },
  { id: 'data_conflict', label: '数据冲突', auto: true },
  { id: 'screening', label: '初筛', auto: true },
  { id: 'deep_research', label: '深度尽调' },
  { id: 'watch', label: '重点观察' },
  { id: 'tge_plan', label: 'TGE 计划' },
  { id: 'tge_exec', label: 'TGE 执行' },
  { id: 'holding', label: '持仓观察' },
  { id: 'exited', label: '退出' },
  { id: 'review', label: '复盘' },
  { id: 'rejected', label: '淘汰' },
]
const STAGE_IDS = new Set(STAGES.map((s) => s.id))
const AUTO_STAGES = new Set(STAGES.filter((s) => s.auto).map((s) => s.id))

// 阶段 → 预算覆盖层级（决定单项目累计点数上限）
function coverageFor(stage) {
  if (['deep_research', 'watch'].includes(stage)) return 'deep_research'
  if (['tge_plan', 'tge_exec', 'holding'].includes(stage)) return 'tge_watch'
  if (stage === 'screening') return 'screening'
  return 'discovery'
}

const CORE_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum', 'solana', 'robinhood']
const PRODUCT_TASK_TYPES = new Set(['mainnet', 'testnet', 'trading', 'staking', 'liquidity', 'node', 'depin', 'deploy'])
const SIGNAL_GROUP = { fundraising: '融资', public_sale: '融资', airdrop: '空投', listing: '代币', tge: '代币', news: '新闻' }

const HARD_LABEL = {
  credible_funding: '有可信融资',
  verifiable_product: '有可验证产品',
  token_plan: '有明确 TGE / 代币计划',
  onchain_activity: '有真实链上活动',
  ecosystem_integration: '有可验证的生态集成',
}
const BONUS_LABEL = {
  core_chain: '属于 6 条核心链',
  multi_source: '多个来源同时出现',
  active_campaign: '积分 / 空投活动进行中',
  social_traction: '社交关注度较高',
}
// M4 才有数据来源的条件：明确标为「暂不可评估」，不当作不满足
const NOT_YET = { onchain_activity: 'M4 接入链上数据后评估', ecosystem_integration: '暂无可靠数据源' }

const COMPLETENESS_ITEMS = [
  ['website', '官网'], ['twitter', 'X 账号'], ['surf_id', 'Surf 记录'], ['contract', '合约地址'],
  ['chains', '所属链'], ['tge', 'TGE 状态'], ['funding', '融资信息'], ['token_data', '代币数据'],
]

function signalLabel(groups, hasProduct) {
  const g = [...new Set(groups)].filter((x) => x !== '新闻')
  const parts = [...g]
  if (hasProduct && !parts.includes('产品')) parts.push('产品')
  if (parts.length >= 3) return '多源确认'
  if (parts.length === 0) return groups.includes('新闻') ? '只有新闻' : '暂无信号'
  if (parts.length === 1) return `只有${parts[0]}信号`
  return parts.join(' + ')
}

/** 收集单个项目的评估事实 */
async function gatherFacts(ids) {
  const projects = await db.query(
    `SELECT id, name, chains, tge_status, surf_project_id, website_domain, twitter_handle, stage, stage_source, merged_into
     FROM wr_projects WHERE id = ANY($1)`, [ids])
  const events = await db.query(
    `SELECT project_id, event_type, link_confidence, importance, data, excluded_reason
     FROM wr_events WHERE project_id = ANY($1)`, [ids])
  const idRows = await db.query(
    `SELECT project_id, array_agg(DISTINCT id_type) AS types FROM wr_project_ids WHERE project_id = ANY($1) GROUP BY 1`, [ids])
  const metricRows = await db.query(
    `SELECT DISTINCT ON (project_id, metric_name) project_id, metric_name, value::float AS value
     FROM wr_metrics WHERE project_id = ANY($1) ORDER BY project_id, metric_name, fetched_at DESC`, [ids])
  const conflicts = await db.query(
    `SELECT project_a, project_b FROM wr_project_relations WHERE status = 'possible_duplicate' AND (project_a = ANY($1) OR project_b = ANY($1))`, [ids])
  const conflictAlerts = await db.query(
    `SELECT project_id FROM wr_alerts WHERE status = 'open' AND alert_type = 'identity_conflict' AND project_id = ANY($1)`, [ids])
  const status = await identityStatus(ids)

  const by = (rows, key = 'project_id') => rows.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {})
  const evBy = by(events)
  const idBy = Object.fromEntries(idRows.map((r) => [r.project_id, new Set(r.types)]))
  const mBy = by(metricRows)
  const conflictSet = new Set([...conflicts.flatMap((c) => [c.project_a, c.project_b]), ...conflictAlerts.map((a) => a.project_id)])

  return projects.map((p) => {
    const evs = (evBy[p.id] || []).filter((e) => !e.excluded_reason)
    const types = new Set(idBy[p.id] || [])
    const metrics = Object.fromEntries((mBy[p.id] || []).map((m) => [m.metric_name, m.value]))
    const chains = p.chains || []
    const airdrops = evs.filter((e) => e.event_type === 'airdrop')
    const taskTypes = new Set(airdrops.flatMap((e) => e.data?.task_types || []))
    const funding = evs.filter((e) => ['fundraising', 'public_sale'].includes(e.event_type))

    // 每个条件记录证据来源（origin），用于要求「至少两个独立来源」
    // 来源：fundraising（融资事件）/ airdrop（空投数据）/ token（上币、TGE）/ detail（项目详情：合约、链、TGE 状态、粉丝）/ metrics
    const origins = {}
    const mark = (key, origin, ok) => { if (ok) (origins[key] ||= new Set()).add(origin) }
    mark('credible_funding', 'fundraising', funding.some((e) => ['high', 'medium'].includes(e.link_confidence) && (e.importance ?? 0) >= 3))
    mark('credible_funding', 'airdrop', airdrops.some((e) => e.link_confidence === 'high' && Number(e.data?.total_raise || 0) > 0))
    mark('verifiable_product', 'detail', types.has('contract'))
    mark('verifiable_product', 'metrics', metrics.tvl_usd > 0)
    mark('verifiable_product', 'airdrop', [...taskTypes].some((t) => PRODUCT_TASK_TYPES.has(t)))
    mark('token_plan', 'detail', ['pre', 'upcoming'].includes(p.tge_status))
    mark('token_plan', 'fundraising', evs.some((e) => e.event_type === 'public_sale'))
    mark('token_plan', 'token', evs.some((e) => ['listing', 'tge'].includes(e.event_type)))
    // 链信息来自 Surf 记录时算「项目详情」来源；仅由标题推断时算「融资事件」来源
    mark('core_chain', p.surf_project_id ? 'detail' : 'fundraising', chains.some((c) => CORE_CHAINS.includes(c)))
    mark('active_campaign', 'airdrop', airdrops.some((e) => Number(e.data?.open_tasks || 0) > 0 || ['CONFIRMED', 'SNAPSHOT', 'VERIFICATION'].includes(e.data?.status)))
    mark('social_traction', 'detail', Number(metrics.twitter_followers || 0) >= 10000)
    mark('social_traction', 'airdrop', airdrops.some((e) => Number(e.data?.xscore || 0) >= 100))
    const groupsSeen = new Set(evs.map((e) => SIGNAL_GROUP[e.event_type]).filter((g) => g && g !== '新闻'))
    if (groupsSeen.size >= 2) origins.multi_source = new Set(['multi'])

    const has = (k) => !!origins[k]
    const hard = {
      credible_funding: has('credible_funding'),
      verifiable_product: has('verifiable_product'),
      token_plan: has('token_plan'),
      onchain_activity: null, // M4
      ecosystem_integration: null,
    }
    const bonus = {
      core_chain: has('core_chain'),
      multi_source: has('multi_source'),
      active_campaign: has('active_campaign'),
      social_traction: has('social_traction'),
    }
    const completeness = {
      website: !!p.website_domain || types.has('domain'),
      twitter: !!p.twitter_handle || types.has('twitter'),
      surf_id: types.has('surf_id'),
      contract: types.has('contract'),
      chains: chains.length > 0,
      tge: !!p.tge_status,
      funding: funding.length > 0 || airdrops.some((e) => Number(e.data?.total_raise || 0) > 0),
      token_data: metrics.fdv_usd != null || metrics.total_supply != null,
    }
    const groups = evs.map((e) => SIGNAL_GROUP[e.event_type]).filter(Boolean)
    return {
      project: p,
      identity: status[p.id] || 'name_only',
      hard, bonus, completeness,
      sourceTypes: [...new Set(evs.map((e) => e.event_type))].sort(),
      signal: signalLabel(groups, hard.verifiable_product),
      conflict: conflictSet.has(p.id),
      origins: Object.fromEntries(Object.entries(origins).map(([k, v]) => [k, [...v]])),
    }
  })
}

const ORIGIN_LABEL = { fundraising: '融资事件', airdrop: '空投数据', token: '上币 / TGE', detail: '项目详情', metrics: '指标', multi: '多来源' }

// 满足的条件背后有几个独立来源（「多个来源同时出现」本身就代表 ≥2）
function independentSources(f, hardMet, bonusMet) {
  const set = new Set([...hardMet, ...bonusMet].flatMap((k) => f.origins[k] || []))
  if (set.has('multi')) return Math.max(2, set.size - 1)
  return set.size
}

/** 根据事实决定自动阶段 */
function decideStage(f) {
  const hardMet = Object.entries(f.hard).filter(([, v]) => v === true).map(([k]) => k)
  const bonusMet = Object.entries(f.bonus).filter(([, v]) => v).map(([k]) => k)
  const missing = COMPLETENESS_ITEMS.filter(([k]) => !f.completeness[k]).map(([, l]) => l)
  let stage
  let reason
  if (f.conflict) {
    stage = 'data_conflict'
    reason = '存在待判断的疑似重复或身份冲突'
  } else if (hardMet.length >= 1 && bonusMet.length >= 1 && f.identity !== 'name_only' && independentSources(f, hardMet, bonusMet) >= 2) {
    stage = 'screening'
    reason = `满足硬条件：${hardMet.map((k) => HARD_LABEL[k]).join('、')}；加分：${bonusMet.map((k) => BONUS_LABEL[k]).join('、')}（${independentSources(f, hardMet, bonusMet)} 个独立来源）`
  } else if (f.identity === 'name_only') {
    stage = 'data_incomplete'
    reason = hardMet.length ? '有信号，但身份只有名称，需先补全身份' : '身份只有名称'
  } else if (hardMet.length >= 1 || bonusMet.length >= 1) {
    stage = 'pending_verify'
    reason = !hardMet.length ? '只有加分条件，没有满足任何硬条件'
      : !bonusMet.length ? '满足硬条件，但没有加分条件'
        : `证据只来自单一来源（${[...new Set([...hardMet, ...bonusMet].flatMap((k) => f.origins[k] || []))].map((o) => ORIGIN_LABEL[o] || o).join('、')}），需要其他来源确认`
  } else {
    stage = 'discovered'
    reason = '暂无可验证的信号'
  }
  return {
    stage, reason,
    facts: {
      hard: Object.fromEntries(Object.entries(f.hard).map(([k, v]) => [k, { met: v, label: HARD_LABEL[k], note: v == null ? NOT_YET[k] : null }])),
      bonus: Object.fromEntries(Object.entries(f.bonus).map(([k, v]) => [k, { met: v, label: BONUS_LABEL[k] }])),
      completeness: Object.fromEntries(COMPLETENESS_ITEMS.map(([k, l]) => [k, { met: f.completeness[k], label: l }])),
      missing, identity: f.identity, conflict: f.conflict,
      origins: Object.fromEntries(Object.entries(f.origins).map(([k, v]) => [k, v.map((o) => ORIGIN_LABEL[o] || o)])),
      independent_sources: independentSources(f, hardMet, bonusMet),
    },
  }
}

/**
 * 评估项目（不传 ids 则评估全部未合并项目）。不调用任何外部接口。
 * 返回 { evaluated, changed:[{id, from, to}] }
 */
async function evaluateProjects(ids = null) {
  const targetIds = ids?.length
    ? ids
    : (await db.query('SELECT id FROM wr_projects WHERE merged_into IS NULL')).map((r) => r.id)
  const changed = []
  for (let i = 0; i < targetIds.length; i += 200) {
    const chunk = targetIds.slice(i, i + 200)
    const all = await gatherFacts(chunk)
    for (const f of all) {
      const p = f.project
      if (p.merged_into) continue
      const d = decideStage(f)
      const done = Object.values(f.completeness).filter(Boolean).length / COMPLETENESS_ITEMS.length
      await db.query(
        `UPDATE wr_projects SET identity_status = $2, source_types = $3, signal_label = $4, completeness = $5,
           screening_facts = $6, evaluated_at = now() WHERE id = $1`,
        [p.id, f.identity, JSON.stringify(f.sourceTypes), f.signal, done.toFixed(3), JSON.stringify(d.facts)],
      )
      const autoManaged = p.stage_source !== 'manual' && (AUTO_STAGES.has(p.stage) || !STAGE_IDS.has(p.stage))
      if (autoManaged && d.stage !== p.stage) {
        await setStage(p.id, d.stage, { source: 'auto', reason: d.reason, facts: d.facts, from: p.stage })
        changed.push({ id: p.id, name: p.name, from: p.stage, to: d.stage })
      } else if (autoManaged) {
        await db.query('UPDATE wr_projects SET stage_reason = $2 WHERE id = $1', [p.id, d.reason])
      }
    }
  }
  return { evaluated: targetIds.length, changed }
}

async function setStage(projectId, stage, { source, reason, facts = null, from } = {}) {
  if (!STAGE_IDS.has(stage)) throw new Error(`未知阶段：${stage}`)
  const cur = from !== undefined ? { stage: from } : await db.one('SELECT stage FROM wr_projects WHERE id = $1', [projectId])
  await db.tx(async (q) => {
    await q(
      `UPDATE wr_projects SET stage = $2, stage_source = $3, stage_reason = $4, stage_changed_at = now(),
         coverage_level = $5, updated_at = now() WHERE id = $1`,
      [projectId, stage, source, reason || null, coverageFor(stage)],
    )
    await q(
      `INSERT INTO wr_stage_history (project_id, from_stage, to_stage, source, reason, facts) VALUES ($1,$2,$3,$4,$5,$6)`,
      [projectId, cur?.stage || null, stage, source, reason || null, facts ? JSON.stringify(facts) : null],
    )
  })
}

/** 人工设定阶段（之后自动规则不再改动阶段） */
async function setStageManual(projectId, stage, reason) {
  if (!reason || !String(reason).trim()) throw new Error('人工调整阶段需要填写理由')
  if (stage === 'merged') throw new Error('不能手动设为已合并')
  const p = await db.one('SELECT id, merged_into FROM wr_projects WHERE id = $1', [projectId])
  if (!p) throw new Error('项目不存在')
  if (p.merged_into) throw new Error(`项目已并入 #${p.merged_into}`)
  await setStage(projectId, stage, { source: 'manual', reason: String(reason).trim() })
}

/** 恢复自动：交还给规则重新评估 */
async function restoreAuto(projectId) {
  const p = await db.one('SELECT stage FROM wr_projects WHERE id = $1', [projectId])
  if (!p) throw new Error('项目不存在')
  await db.query(`UPDATE wr_projects SET stage_source = 'auto' WHERE id = $1`, [projectId])
  // 当前若是自动区之外的阶段，先放回「发现」再评估
  if (!AUTO_STAGES.has(p.stage)) {
    await setStage(projectId, 'discovered', { source: 'auto', reason: '恢复自动评估', from: p.stage })
  }
  return evaluateProjects([projectId])
}

module.exports = {
  STAGES, AUTO_STAGES, COMPLETENESS_ITEMS, HARD_LABEL, BONUS_LABEL, coverageFor,
  evaluateProjects, setStageManual, restoreAuto, decideStage, signalLabel,
}
