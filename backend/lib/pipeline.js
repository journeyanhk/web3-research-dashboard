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
  { id: 'opportunity_chain', label: '机会链', auto: true }, // M2.3：已确认在 6 条核心链之外，或是新公链 / L2 本身
  { id: 'listed_watch', label: '已上市观察', auto: true }, // M2.3：已有代币市场，移出早期池
  { id: 'non_early', label: '非早期项目', auto: true }, // M2.3：成熟项目 / 核心链本身
  { id: 'dormant', label: '休眠', auto: true }, // M2.3：14 天无新有效信号
  { id: 'archived', label: '归档', auto: true }, // M2.3：30 天无新有效信号（可自动恢复）
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
// 可进入休眠 / 归档的阶段（初筛等待人工判断，不自动休眠；已移出早期池的不再处理）
const DORMANCY_STAGES = new Set(['discovered', 'data_incomplete', 'pending_verify', 'opportunity_chain'])

// 阶段 → 预算覆盖层级（决定单项目累计点数上限）
function coverageFor(stage) {
  if (['deep_research', 'watch'].includes(stage)) return 'deep_research'
  if (['tge_plan', 'tge_exec', 'holding'].includes(stage)) return 'tge_watch'
  if (stage === 'screening') return 'screening'
  return 'discovery'
}

const RULE_VERSION = 'pipeline-v4'
// m2.3.1（M2.3 Review 修正）：空投任务所在链不再算已确认链；仅有市值数据不再判定已上市；快照区分类型
const SCREENING_RULE_VERSION = 'm2.3.1'
const SNAPSHOT_TYPES = ['historical_runtime', 'migration_backfill', 'manual_recalculate']
const CORE_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum', 'solana', 'robinhood']
// 产品证据分层（M2.1）：空投任务只能作为「产品候选信号」，且只有主网/测试网/部署/节点类任务才算；
// 交易、质押、提供流动性任务可能只是要求用户与第三方协议交互，不算产品证据
const PRODUCT_TASK_TYPES = new Set(['mainnet', 'testnet', 'node', 'deploy'])
const SIGNAL_GROUP = { fundraising: '融资', public_sale: '融资', airdrop: '空投', listing: '代币', tge: '代币', news: '新闻' }

// M2.3 默认参数（可在 settings.pipeline_config 中覆盖）
const DEFAULT_PIPELINE_CONFIG = {
  dormant_days: 14, // 无新有效信号 N 天 → 休眠
  archive_days: 30, // 无新有效信号 N 天 → 归档
  mature_market_cap_usd: 300e6, // 已上市且流通市值 ≥ 3 亿美元 → 成熟项目
  mature_fdv_usd: 1e9, // 已上市且 FDV ≥ 10 亿美元 → 成熟项目
}

// 独立来源分组：同一组内的证据（哪怕来自不同接口、不同字段）只算一个来源
const GROUP_LABEL = {
  surf_project: 'Surf 项目资料（详情 / 空投 / TGE 状态）',
  surf_fundraising: 'Surf 融资事件',
  official_project: '项目官方 / 人工核实',
  onchain: '链上数据',
  github: 'GitHub',
  market_data: '市场 / 交易所数据',
  external_news: '外部新闻',
}

// 公链 / L2 本身：Surf 标签，或名称就是一条知名链
const CHAIN_INFRA_TAGS = new Set(['Layer1', 'Layer2 & Scaling'])
const KNOWN_CHAIN_NAMES = new Set([
  'base', 'ethereum', 'solana', 'bnbchain', 'bnbsmartchain', 'bsc', 'arbitrum', 'arbitrumone', 'robinhoodchain',
  'optimism', 'polygon', 'avalanche', 'sui', 'aptos', 'ton', 'tron', 'near', 'celestia', 'monad', 'berachain', 'sonic',
  'abstract', 'linea', 'scroll', 'zksync', 'blast', 'mantle', 'starknet', 'hyperliquid', 'hyperevm', 'megaeth',
])

const HARD_LABEL = {
  credible_funding: '有可信融资',
  verifiable_product: '有可验证产品',
  token_plan: '有明确 TGE / 代币计划',
  onchain_activity: '有真实链上活动',
  ecosystem_integration: '有可验证的生态集成',
}
const BONUS_LABEL = {
  core_chain: '已确认属于 6 条核心链',
  multi_source: '多个独立数据集同时出现',
  active_campaign: '积分 / 空投活动进行中',
  social_traction: '社交关注度较高',
}
// M4 才有数据来源的条件：明确标为「暂不可评估」，不当作不满足
const NOT_YET = { onchain_activity: 'M4 接入链上数据后评估', ecosystem_integration: '暂无可靠数据源' }

const MATURITY_LABEL = {
  early: '早期', pre_tge: 'TGE 前', listed: '已上市', mature: '成熟项目', chain_infrastructure: '公链 / L2 本身', unknown: '未知',
}
const CHAIN_STATUS_LABEL = {
  core_confirmed: '已确认核心链', other_confirmed: '已确认其他链', inferred: '待核实链', none: '无链信息',
}
const CHAIN_SOURCE_LABEL = {
  manual: '人工确认', surf_detail: 'Surf 项目详情', contract_chain: '合约所在链', airdrop_task: '空投任务所在链（仅线索）', inferred: '文字推断',
}
const CONFIRMED_CHAIN_SOURCES = ['manual', 'surf_detail', 'contract_chain']
// 上市证据：confirmed = TGE 状态为已 TGE，或有已确认关联的交易所上币事件（M4 起再加 DEX 交易池 / 有效流动性）；
// inferred = 只有市值 / FDV 数据（可能是估值、残留或低流动性价格），不据此移出早期池
const LISTING_EVIDENCE_LABEL = { confirmed: '已确认上市', inferred: '市场数据显示可能已上市（待核实）', none: '无上市证据' }

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

const normName = (n) => String(n || '').toLowerCase().normalize('NFKC').replace(/[\s._\-·•'’"“”()（）]+/g, '')

async function loadPipelineConfig() {
  try {
    const saved = await require('./registry').getSetting('pipeline_config')
    return { ...DEFAULT_PIPELINE_CONFIG, ...(saved || {}) }
  } catch { return { ...DEFAULT_PIPELINE_CONFIG } }
}

/** 链状态：只有「人工确认 / Surf 详情 / 合约所在链」算已确认；空投任务所在链和文字推断的链只算待核实 */
function chainStatusOf(chains, chainSource) {
  const list = chains || []
  if (!list.length) return 'none'
  const confirmed = CONFIRMED_CHAIN_SOURCES.includes(chainSource)
  if (!confirmed) return 'inferred'
  return list.some((c) => CORE_CHAINS.includes(c)) ? 'core_confirmed' : 'other_confirmed'
}

/** 成熟度：成熟 > 公链本身 > 已上市 > TGE 前 > 早期 > 未知 */
function listingLevelOf({ tgeStatus, metrics = {}, confirmedListing = false }) {
  if (tgeStatus === 'post' || confirmedListing) return 'confirmed'
  if (Number(metrics.market_cap_usd || 0) > 0 || Number(metrics.fdv_usd || 0) > 0) return 'inferred'
  return 'none'
}

function maturityOf({ name, tags, tgeStatus, metrics, identity, listingLevel }, cfg = DEFAULT_PIPELINE_CONFIG) {
  const mcap = Number(metrics.market_cap_usd || 0)
  const fdv = Number(metrics.fdv_usd || 0)
  // 只有已确认的上市证据才算已上市；仅有市值数据保持原成熟度，并在事实里标记待核实
  const listed = (listingLevel || listingLevelOf({ tgeStatus, metrics })) === 'confirmed'
  const knownChain = KNOWN_CHAIN_NAMES.has(normName(name))
  const infra = knownChain || (tags || []).some((t) => CHAIN_INFRA_TAGS.has(t))
  if (listed && (mcap >= cfg.mature_market_cap_usd || fdv >= cfg.mature_fdv_usd)) return { status: 'mature', knownChain }
  if (infra) return { status: 'chain_infrastructure', knownChain }
  if (listed) return { status: 'listed', knownChain }
  if (['pre', 'upcoming'].includes(tgeStatus)) return { status: 'pre_tge', knownChain }
  if (identity !== 'name_only') return { status: 'early', knownChain }
  return { status: 'unknown', knownChain }
}

/** 收集单个项目的评估事实 */
async function gatherFacts(ids) {
  const projects = await db.query(
    `SELECT id, name, chains, chain_source, tags, flags, tge_status, surf_project_id, website_domain, twitter_handle,
            stage, stage_source, merged_into, first_seen_at, last_signal_at, campaign_chains, detail_fetched_at
     FROM wr_projects WHERE id = ANY($1)`, [ids])
  const events = await db.query(
    `SELECT id, project_id, event_type, endpoint, link_confidence, importance, data, excluded_reason, created_at, event_at
     FROM wr_events WHERE project_id = ANY($1)`, [ids])
  const idRows = await db.query(
    `SELECT project_id, array_agg(DISTINCT id_type) AS types FROM wr_project_ids WHERE project_id = ANY($1) GROUP BY 1`, [ids])
  const metricRows = await db.query(
    `SELECT DISTINCT ON (project_id, metric_name) project_id, metric_name, value::float AS value, source, fetched_at
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
    const metricList = mBy[p.id] || []
    const metrics = Object.fromEntries(metricList.map((m) => [m.metric_name, m.value]))
    const metricAt = Object.fromEntries(metricList.map((m) => [m.metric_name, m.fetched_at]))
    const chains = p.chains || []
    const chainStatus = chainStatusOf(chains, p.chain_source)
    const airdrops = evs.filter((e) => e.event_type === 'airdrop')
    const taskTypes = new Set(airdrops.flatMap((e) => e.data?.task_types || []))
    const funding = evs.filter((e) => ['fundraising', 'public_sale'].includes(e.event_type))
    const ident = status[p.id] || 'name_only'

    // 证据清单（M2.3）：每条证据记录 条件 / 证据类型 / 提供方 / 接口 / 记录 ID / 独立来源分组 / 时间。
    // 同一条记录的多个字段、同一提供方同一数据实体的不同接口，都归入同一分组，只算一个来源。
    const evidence = []
    const add = (condition, type, group, { source, record, at, counted = true, note } = {}) => {
      evidence.push({ condition, evidence_type: type, evidence_provider: source === 'manual' ? 'self' : 'surf',
        evidence_source: source || null, evidence_record_id: record || null, independence_group: group,
        observed_at: at || null, counted, note: note || null })
    }
    const evRec = (e) => `event:${e.id}`
    for (const e of funding) {
      const ok = ['high', 'medium'].includes(e.link_confidence) && (e.importance ?? 0) >= 3
      add('credible_funding', e.event_type === 'public_sale' ? 'public_sale_event' : 'fundraising_event', 'surf_fundraising',
        { source: e.endpoint || 'search/fundraising', record: evRec(e), at: e.created_at, counted: ok,
          note: ok ? null : '关联置信度低或重要度不足，不计入' })
      if (e.event_type === 'public_sale' && ['high', 'medium'].includes(e.link_confidence)) {
        add('token_plan', 'public_sale_event', 'surf_fundraising', { source: e.endpoint || 'search/fundraising', record: evRec(e), at: e.created_at })
      }
    }
    for (const e of airdrops) {
      const high = e.link_confidence === 'high'
      if (Number(e.data?.total_raise || 0) > 0) {
        add('credible_funding', 'airdrop_total_raise', 'surf_project', { source: 'search/airdrop', record: evRec(e), at: e.created_at,
          counted: high, note: high ? '空投记录中的融资字段，与同一记录的其他字段只算一个来源' : '空投记录未通过 Surf ID 关联，不计入' })
      }
      if ((e.data?.task_types || []).some((t) => PRODUCT_TASK_TYPES.has(t))) {
        add('verifiable_product', 'airdrop_product_task', 'surf_project', { source: 'search/airdrop', record: evRec(e), at: e.created_at, note: '低强度产品证据（空投任务）' })
      }
      if (Number(e.data?.open_tasks || 0) > 0 || ['CONFIRMED', 'SNAPSHOT', 'VERIFICATION'].includes(e.data?.status)) {
        add('active_campaign', 'airdrop_campaign', 'surf_project', { source: 'search/airdrop', record: evRec(e), at: e.created_at })
      }
      if (Number(e.data?.xscore || 0) >= 100) {
        add('social_traction', 'airdrop_xscore', 'surf_project', { source: 'search/airdrop', record: evRec(e), at: e.created_at })
      }
    }
    if (types.has('contract')) add('verifiable_product', 'contract', 'surf_project', { source: 'project/detail', record: p.surf_project_id ? `surf:${p.surf_project_id}` : null })
    if (metrics.tvl_usd > 0) add('verifiable_product', 'tvl', metricSourceGroup(metricList, 'tvl_usd'), { source: 'metrics', record: 'metric:tvl_usd', at: metricAt.tvl_usd })
    if (['pre', 'upcoming'].includes(p.tge_status)) add('token_plan', 'tge_status', 'surf_project', { source: 'project/detail', record: p.surf_project_id ? `surf:${p.surf_project_id}` : null })
    for (const e of evs.filter((x) => x.event_type === 'tge')) {
      add('token_plan', 'tge_event', 'surf_project', { source: e.endpoint || 'project/detail', record: evRec(e), at: e.created_at })
    }
    for (const e of evs.filter((x) => x.event_type === 'listing')) {
      const ok = ['high', 'medium'].includes(e.link_confidence)
      add('token_plan', 'exchange_listing', 'market_data', { source: e.endpoint || 'market/listing', record: evRec(e), at: e.created_at,
        counted: ok, note: ok ? null : '仅按代币符号关联，未确认是同一项目，不计入' })
    }
    if (chainStatus === 'core_confirmed') {
      add('core_chain', 'chains', p.chain_source === 'manual' ? 'official_project' : 'surf_project',
        { source: p.chain_source, record: p.surf_project_id ? `surf:${p.surf_project_id}` : null })
    } else if (chainStatus === 'inferred' && chains.some((c) => CORE_CHAINS.includes(c))) {
      const fromAirdrop = p.chain_source === 'airdrop_task'
      add('core_chain', fromAirdrop ? 'chains_airdrop_task' : 'chains_inferred', 'surf_project', {
        source: p.chain_source || 'inferred', counted: false,
        note: fromAirdrop ? '链来自空投任务要求，不代表项目部署链，待核实，不计入' : '链由文字推断，待核实，不计入',
      })
    }
    if (Number(metrics.twitter_followers || 0) >= 10000) {
      add('social_traction', 'twitter_followers', 'surf_project', { source: 'project/detail', record: 'metric:twitter_followers', at: metricAt.twitter_followers })
    }

    // 多个独立数据集：已关联且计入的事件来自 ≥2 个独立来源分组
    const eventGroups = new Set(evidence.filter((x) => x.counted && x.evidence_record_id?.startsWith('event:')).map((x) => x.independence_group))
    const origins = {}
    for (const x of evidence.filter((v) => v.counted)) (origins[x.condition] ||= new Set()).add(x.independence_group)
    if (eventGroups.size >= 2) origins.multi_source = new Set(['multi'])

    // 产品证据强度：合约 / TVL = 高；仅空投任务 = 低（候选信号，M3 评分时不给高分）
    const productLevel = types.has('contract') || metrics.tvl_usd > 0 ? 'high'
      : [...taskTypes].some((t) => PRODUCT_TASK_TYPES.has(t)) ? 'low' : null
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
      chains: chainStatus !== 'none',
      tge: !!p.tge_status,
      funding: funding.length > 0 || airdrops.some((e) => Number(e.data?.total_raise || 0) > 0),
      token_data: metrics.fdv_usd != null || metrics.total_supply != null,
    }
    // 高质量融资：有计入的 Surf 融资事件（不是空投记录里的融资字段）
    // 上市证据分级：TGE 已完成，或有已确认关联的交易所上币事件
    const confirmedListing = evs.some((e) => e.event_type === 'listing' && ['high', 'medium'].includes(e.link_confidence))
    const listingLevel = listingLevelOf({ tgeStatus: p.tge_status, metrics, confirmedListing })
    // 本次评估所用数据的截止时间：最近的事件 / 详情 / 指标
    const times = [...evs.map((e) => e.created_at), p.detail_fetched_at, ...metricList.map((m) => m.fetched_at)]
      .filter(Boolean).map((t) => new Date(t).getTime())
    const dataAsOf = times.length ? new Date(Math.max(...times)).toISOString() : null
    const qualityFunding = evidence.some((x) => x.counted && x.condition === 'credible_funding' && x.independence_group === 'surf_fundraising')
    const groups = evs.map((e) => SIGNAL_GROUP[e.event_type]).filter(Boolean)
    return {
      project: p,
      identity: ident,
      hard, bonus, completeness, metrics,
      chainStatus, chainSource: p.chain_source || null, chains, campaignChains: p.campaign_chains || [],
      listingLevel, dataAsOf,
      flags: p.flags || [],
      lastSignalAt: p.last_signal_at || p.first_seen_at,
      sourceTypes: [...new Set(evs.map((e) => e.event_type))].sort(),
      signal: signalLabel(groups, hard.verifiable_product),
      conflict: conflictSet.has(p.id),
      origins: Object.fromEntries(Object.entries(origins).map(([k, v]) => [k, [...v]])),
      evidence,
      productLevel,
      qualityFunding,
      tags: p.tags || [],
    }
  })
}

// 指标来源分组：Surf 提供的指标归入 Surf 项目资料；Helius / DexScreener 等归入链上或市场数据
function metricSourceGroup(list, name) {
  const m = list.find((x) => x.metric_name === name)
  const src = String(m?.source || 'surf')
  if (['helius', 'onchain', 'sql'].includes(src)) return 'onchain'
  if (['dexscreener', 'geckoterminal'].includes(src)) return 'market_data'
  return 'surf_project'
}

const ORIGIN_LABEL = { ...GROUP_LABEL, multi: '多来源' }

// 满足的条件背后涉及几个独立来源分组（「多个独立数据集」本身不额外计组）
function independentGroups(f, hardMet, bonusMet) {
  return [...new Set([...hardMet, ...bonusMet].filter((k) => k !== 'multi_source').flatMap((k) => f.origins[k] || []))]
}

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—')
const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null)

/** 根据事实决定自动阶段（M2.3） */
function decideStage(f, cfg = DEFAULT_PIPELINE_CONFIG) {
  const hardMet = Object.entries(f.hard).filter(([, v]) => v === true).map(([k]) => k)
  const bonusMet = Object.entries(f.bonus).filter(([, v]) => v).map(([k]) => k)
  const missing = COMPLETENESS_ITEMS.filter(([k]) => !f.completeness[k]).map(([, l]) => l)
  const groups = independentGroups(f, hardMet, bonusMet)
  const listingLevel = f.listingLevel || listingLevelOf({ tgeStatus: f.project.tge_status, metrics: f.metrics || {} })
  const maturity = maturityOf({ name: f.project.name, tags: f.tags, tgeStatus: f.project.tge_status, metrics: f.metrics || {}, identity: f.identity, listingLevel }, cfg)
  const qualifies = hardMet.length >= 1 && bonusMet.length >= 1 && groups.length >= 2
  const chainText = (f.chains || []).join(', ') || '—'
  let stage
  let reason
  let focus = false

  if (f.conflict) {
    stage = 'data_conflict'
    reason = '存在待判断的疑似重复或身份冲突'
  } else if (maturity.status === 'mature') {
    stage = 'non_early'
    reason = '已上市且市值 / FDV 较大，属于成熟项目，移出早期池（数据保留，可用于回测）'
  } else if (maturity.status === 'chain_infrastructure' && maturity.knownChain) {
    stage = 'non_early'
    reason = '项目本身就是一条公链 / L2，不是链上的早期项目，移出早期池'
  } else if (maturity.status === 'listed') {
    stage = 'listed_watch'
    reason = '已有代币市场（已 TGE），移出早期池，进入已上市观察'
  } else if (maturity.status === 'chain_infrastructure') {
    stage = 'opportunity_chain'
    reason = '项目是新的公链 / L2 本身，不属于 6 条核心链上的项目，放入机会链观察'
  } else if (f.identity === 'name_only') {
    stage = 'data_incomplete'
    const fl = new Set(f.flags || [])
    reason = fl.has('surf_multiple_matches') ? '身份只有名称：Surf 中有多个同名项目，需人工确认'
      : fl.has('surf_not_found') ? '身份只有名称：Surf 中查不到，出现新信号前不再查询'
        : hardMet.length ? '有信号，但身份只有名称，等待身份补全' : '身份只有名称，等待身份补全'
  } else if (f.chainStatus === 'other_confirmed') {
    stage = 'opportunity_chain'
    reason = `已确认所在链（${chainText}）不在 6 条核心链内，放入机会链，不进核心初筛`
  } else if (f.chainStatus === 'none' && f.qualityFunding && f.productLevel) {
    stage = 'pending_verify'
    focus = true
    reason = '待验证重点：有高质量融资和产品证据，但缺所属链信息，需先核实链'
  } else if (qualifies && f.chainStatus === 'core_confirmed') {
    stage = 'screening'
    reason = `满足硬条件：${hardMet.map((k) => HARD_LABEL[k]).join('、')}；加分：${bonusMet.map((k) => BONUS_LABEL[k]).join('、')}（${groups.length} 个独立来源：${groups.map((g) => GROUP_LABEL[g] || g).join('、')}）`
  } else if (qualifies && f.chainStatus === 'inferred') {
    stage = 'pending_verify'
    reason = f.chainSource === 'airdrop_task'
      ? `满足初筛条件，但所属链（${chainText}）只来自空投任务要求，不代表项目部署链，待核实链后才能进初筛`
      : `满足初筛条件，但所属链（${chainText}）只是文字推断，待核实链后才能进初筛`
  } else if (qualifies && f.chainStatus === 'none') {
    stage = 'data_incomplete'
    reason = '满足初筛条件，但缺所属链信息，补全后才能进初筛'
  } else if (hardMet.length >= 1 || bonusMet.length >= 1) {
    stage = 'pending_verify'
    reason = !hardMet.length ? '只有加分条件，没有满足任何硬条件'
      : !bonusMet.length ? '满足硬条件，但没有加分条件'
        : `证据只来自 ${groups.length} 个独立来源（${groups.map((g) => GROUP_LABEL[g] || g).join('、') || '—'}），需要另一个独立来源确认`
  } else {
    stage = 'discovered'
    reason = '暂无可验证的信号'
  }

  if (listingLevel === 'inferred' && !['non_early', 'listed_watch', 'opportunity_chain'].includes(stage)) {
    reason += '（另：市场数据显示可能已上市，但没有 TGE / 上币确认，暂留早期池待核实）'
  }

  // 休眠 / 归档：只针对低信息阶段；初筛等待人工判断，已移出早期池的不处理
  const idle = daysSince(f.lastSignalAt)
  const wouldBe = stage
  if (DORMANCY_STAGES.has(stage) && idle != null) {
    if (idle >= cfg.archive_days) {
      stage = 'archived'
      reason = `${idle} 天没有新的有效信号（最近：${fmtDate(f.lastSignalAt)}），暂时归档；出现融资、TGE、上币、空投或详情等新信号时自动恢复。原阶段：${STAGE_LABEL_MAP[wouldBe]}`
    } else if (idle >= cfg.dormant_days) {
      stage = 'dormant'
      reason = `${idle} 天没有新的有效信号（最近：${fmtDate(f.lastSignalAt)}），进入休眠；${cfg.archive_days} 天仍无信号将归档。原阶段：${STAGE_LABEL_MAP[wouldBe]}`
    }
  }

  return {
    stage, reason,
    facts: {
      hard: Object.fromEntries(Object.entries(f.hard).map(([k, v]) => [k, { met: v, label: HARD_LABEL[k], note: v == null ? NOT_YET[k] : null }])),
      bonus: Object.fromEntries(Object.entries(f.bonus).map(([k, v]) => [k, { met: v, label: BONUS_LABEL[k] }])),
      completeness: Object.fromEntries(COMPLETENESS_ITEMS.map(([k, l]) => [k, { met: f.completeness[k], label: l }])),
      missing, identity: f.identity, conflict: f.conflict,
      origins: Object.fromEntries(Object.entries(f.origins).map(([k, v]) => [k, v.map((o) => ORIGIN_LABEL[o] || o)])),
      evidence: f.evidence || [],
      independence_groups: groups,
      independent_sources: groups.length, // 兼容旧字段：现在表示「独立来源分组数」
      evidence_categories: groups.length,
      qualifies,
      maturity: maturity.status,
      chain_status: f.chainStatus,
      chain_source: f.chainSource,
      chains: f.chains || [],
      campaign_chains: f.campaignChains || [],
      listing_evidence_level: listingLevel,
      market_data_suggests_listed: listingLevel === 'inferred',
      data_as_of: f.dataAsOf || null,
      focus,
      would_be_stage: wouldBe !== stage ? wouldBe : null,
      last_signal_at: f.lastSignalAt ? new Date(f.lastSignalAt).toISOString() : null,
      product_evidence_level: f.productLevel || null,
      rule_version: RULE_VERSION,
      screening_rule_version: SCREENING_RULE_VERSION,
    },
  }
}
const STAGE_LABEL_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s.label]))

/**
 * 评估项目（不传 ids 则评估全部未合并项目）。不调用任何外部接口。
 * 返回 { evaluated, changed:[{id, from, to}] }
 */
async function evaluateProjects(ids = null, { snapshotType = 'historical_runtime' } = {}) {
  if (!SNAPSHOT_TYPES.includes(snapshotType)) throw new Error(`未知快照类型：${snapshotType}`)
  const targetIds = ids?.length
    ? ids
    : (await db.query('SELECT id FROM wr_projects WHERE merged_into IS NULL')).map((r) => r.id)
  const cfg = await loadPipelineConfig()
  const changed = []
  let snapshots = 0
  for (let i = 0; i < targetIds.length; i += 200) {
    const chunk = targetIds.slice(i, i + 200)
    const all = await gatherFacts(chunk)
    const lastHashes = Object.fromEntries((await db.query(
      `SELECT DISTINCT ON (project_id) project_id, facts_hash FROM wr_screening_snapshots
       WHERE project_id = ANY($1) ORDER BY project_id, created_at DESC, id DESC`, [chunk])).map((r) => [r.project_id, r.facts_hash]))
    for (const f of all) {
      const p = f.project
      if (p.merged_into) continue
      const d = decideStage(f, cfg)
      const done = Object.values(f.completeness).filter(Boolean).length / COMPLETENESS_ITEMS.length
      await db.query(
        `UPDATE wr_projects SET identity_status = $2, source_types = $3, signal_label = $4, completeness = $5,
           screening_facts = $6, evaluated_at = now(), maturity_status = $7, chain_status = $8, screening_rule_version = $9,
           listing_evidence_level = $10
         WHERE id = $1`,
        [p.id, f.identity, JSON.stringify(f.sourceTypes), f.signal, done.toFixed(3), JSON.stringify(d.facts),
          d.facts.maturity, d.facts.chain_status, SCREENING_RULE_VERSION, d.facts.listing_evidence_level],
      )
      const autoManaged = p.stage_source !== 'manual' && (AUTO_STAGES.has(p.stage) || !STAGE_IDS.has(p.stage))
      let finalStage = p.stage
      let finalReason = d.reason
      if (autoManaged && d.stage !== p.stage) {
        // 从休眠 / 归档恢复：记为重新激活
        const reactivated = ['dormant', 'archived'].includes(p.stage) && !['dormant', 'archived'].includes(d.stage)
        if (reactivated) finalReason = `出现新信号，重新激活：${d.reason}`
        await setStage(p.id, d.stage, { source: 'auto', reason: finalReason, facts: d.facts, from: p.stage })
        if (reactivated) await db.query('UPDATE wr_projects SET reactivated_at = now() WHERE id = $1', [p.id])
        changed.push({ id: p.id, name: p.name, from: p.stage, to: d.stage, reactivated })
        finalStage = d.stage
      } else if (autoManaged) {
        await db.query('UPDATE wr_projects SET stage_reason = $2 WHERE id = $1', [p.id, d.reason])
      } else {
        finalReason = null
      }
      // 筛选结果快照：阶段或事实有变化才追加（只增不改，M3 改规则时历史结果可追溯）
      const hash = factsHash(finalStage, d.facts)
      if (lastHashes[p.id] !== hash) {
        await db.query(
          `INSERT INTO wr_screening_snapshots (project_id, rule_version, stage, stage_reason, facts, facts_hash, snapshot_type, data_as_of)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [p.id, SCREENING_RULE_VERSION, finalStage, finalReason, JSON.stringify(d.facts), hash, snapshotType, d.facts.data_as_of])
        snapshots++
      }
    }
  }
  return { evaluated: targetIds.length, changed, snapshots }
}

function factsHash(stage, facts) {
  return require('node:crypto').createHash('sha1').update(JSON.stringify({ stage, facts })).digest('hex')
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
      `INSERT INTO wr_stage_history (project_id, from_stage, to_stage, source, reason, facts, operator, rule_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId, cur?.stage || null, stage, source, reason || null, facts ? JSON.stringify(facts) : null,
        source === 'manual' ? 'self' : 'system', source === 'auto' ? RULE_VERSION : null],
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
  return evaluateProjects([projectId], { snapshotType: 'manual_recalculate' })
}

/** 人工确认所属链（M2.3）：写入链并标记来源为「人工确认」，然后重新评估 */
async function confirmChains(projectId, chains, note) {
  const list = [...new Set((chains || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean))]
  if (!list.length) throw new Error('请至少选择一条链')
  const p = await db.one('SELECT id, merged_into, chains, chain_source, stage FROM wr_projects WHERE id = $1', [projectId])
  if (!p) throw new Error('项目不存在')
  if (p.merged_into) throw new Error(`项目已并入 #${p.merged_into}`)
  await require('./identity').setChains(projectId, list, 'manual')
  await db.query(
    `INSERT INTO wr_notes (project_id, body) VALUES ($1, $2)`,
    [projectId, `人工确认所属链：${list.join(', ')}（原：${(p.chains || []).join(', ') || '无'}，来源：${p.chain_source || '无'}）${note ? `；说明：${note}` : ''}`],
  )
  const r = await evaluateProjects([projectId], { snapshotType: 'manual_recalculate' })
  // 每次人工确认链都在阶段历史里留一条人工记录（阶段变化本身由规则评估另行记录）
  const cur = await db.one('SELECT stage FROM wr_projects WHERE id = $1', [projectId])
  const stageNote = cur.stage === p.stage ? '阶段不变' : `规则重新评估：${STAGE_LABEL_MAP[p.stage] || p.stage} → ${STAGE_LABEL_MAP[cur.stage] || cur.stage}`
  await db.query(
    `INSERT INTO wr_stage_history (project_id, from_stage, to_stage, source, reason, operator, rule_version)
     VALUES ($1,$2,$3,'manual',$4,'self',$5)`,
    [projectId, p.stage, cur.stage, `人工确认所属链：${list.join(', ')}（${stageNote}）`, RULE_VERSION])
  return r
}

module.exports = {
  STAGES, AUTO_STAGES, DORMANCY_STAGES, COMPLETENESS_ITEMS, HARD_LABEL, BONUS_LABEL, RULE_VERSION, SCREENING_RULE_VERSION,
  GROUP_LABEL, MATURITY_LABEL, CHAIN_STATUS_LABEL, CHAIN_SOURCE_LABEL, LISTING_EVIDENCE_LABEL, CONFIRMED_CHAIN_SOURCES, SNAPSHOT_TYPES,
  DEFAULT_PIPELINE_CONFIG, CORE_CHAINS, coverageFor, factsHash, listingLevelOf,
  evaluateProjects, setStageManual, restoreAuto, decideStage, signalLabel, chainStatusOf, maturityOf, confirmChains, gatherFacts,
}
