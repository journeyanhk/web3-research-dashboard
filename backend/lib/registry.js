// 注册表：链能力矩阵、数据源、系统配置。首次启动写入默认值，之后以数据库为准（可在页面修改）。
const db = require('./db')

// 能力等级：full=完整 partial=部分 inferred=推算(仅辅助观察，不计入正式评分) none=无
const LEVEL_FACTOR = { full: 1, partial: 0.5, inferred: 0, none: 0 }

const DEFAULT_COVERAGE_WEIGHTS = { holders: 0.25, dex: 0.25, activity: 0.2, flows: 0.2, tvl: 0.1 }

const cap = (level, source, note) => ({ level, source, note })

const DEFAULT_CHAINS = [
  {
    id: 'ethereum', name: 'Ethereum', tier: 'A', status: 'core', sort_order: 1,
    capabilities: {
      discovery: cap('full', 'surf'), project_detail: cap('full', 'surf'), tokenomics: cap('full', 'surf'),
      holders: cap('full', 'surf', '持仓 + 地址身份标签'), dex: cap('full', 'surf', 'DEX 逐笔交易'),
      activity: cap('full', 'surf_sql', '链上 SQL：活跃地址/交易数'), flows: cap('full', 'surf', '转账与对手方'),
      tvl: cap('full', 'surf'),
    },
  },
  {
    id: 'bsc', name: 'BNB Chain', tier: 'A', status: 'core', sort_order: 2,
    capabilities: {
      discovery: cap('full', 'surf'), project_detail: cap('full', 'surf'), tokenomics: cap('full', 'surf'),
      holders: cap('full', 'surf'), dex: cap('full', 'surf'),
      activity: cap('full', 'surf_sql', '由转账表计算活跃地址'), flows: cap('full', 'surf'), tvl: cap('full', 'surf'),
    },
  },
  {
    id: 'base', name: 'Base', tier: 'A', status: 'core', sort_order: 3,
    capabilities: {
      discovery: cap('full', 'surf'), project_detail: cap('full', 'surf'), tokenomics: cap('full', 'surf'),
      holders: cap('full', 'surf'), dex: cap('full', 'surf'), activity: cap('full', 'surf_sql'),
      flows: cap('full', 'surf'), tvl: cap('full', 'surf'),
    },
  },
  {
    id: 'arbitrum', name: 'Arbitrum', tier: 'A', status: 'core', sort_order: 4,
    capabilities: {
      discovery: cap('full', 'surf'), project_detail: cap('full', 'surf'), tokenomics: cap('full', 'surf'),
      holders: cap('full', 'surf'), dex: cap('full', 'surf'), activity: cap('full', 'surf_sql'),
      flows: cap('full', 'surf'), tvl: cap('full', 'surf'),
    },
  },
  {
    id: 'solana', name: 'Solana', tier: 'B', status: 'core', sort_order: 5,
    capabilities: {
      discovery: cap('full', 'surf'), project_detail: cap('full', 'surf'), tokenomics: cap('full', 'surf'),
      holders: cap('full', 'surf+helius', 'Surf 持仓 + Helius 补充'),
      dex: cap('full', 'dexscreener→geckoterminal', '价格/流动性/成交量（池子级）'),
      activity: cap('partial', 'dexscreener', '仅交易笔数，无链上 SQL'),
      flows: cap('partial', 'helius', '只针对候选项目的大户'), tvl: cap('full', 'surf'),
    },
    sources: { external: ['helius', 'dexscreener', 'geckoterminal'] },
  },
  {
    id: 'robinhood', name: 'Robinhood Chain', tier: 'C', status: 'core', sort_order: 6,
    capabilities: {
      discovery: cap('full', 'surf'), project_detail: cap('partial', 'surf'), tokenomics: cap('partial', 'surf'),
      holders: cap('inferred', 'surf_sql', '由转账推算，仅辅助观察，不计入集中度评分'),
      dex: cap('partial', 'surf_sql', '每周汇总'), activity: cap('full', 'surf_sql', 'chain_daily'),
      flows: cap('partial', 'surf_sql', '大额转账推算'), tvl: cap('none', null),
    },
    notes: '可交易推荐需人工复核（默认开启）',
  },
  {
    id: 'arc', name: 'Arc', tier: 'X', status: 'paused', sort_order: 99,
    capabilities: {
      discovery: cap('partial', 'surf', '仅新闻/融资'), project_detail: cap('none', null), tokenomics: cap('none', null),
      holders: cap('none', null), dex: cap('none', null), activity: cap('none', null), flows: cap('none', null), tvl: cap('none', null),
    },
    notes: '暂停：满足数据门槛后再启用',
  },
]

const DEFAULT_PROVIDERS = [
  { id: 'surf', name: 'Surf 数据', kind: 'paid', unit: '点', monthly_quota: null, rate_limit: { min_interval_ms: 150 } },
  {
    id: 'helius', name: 'Helius (Solana)', kind: 'free_quota', unit: 'credits', monthly_quota: 1000000,
    rate_limit: { rpc_per_sec: 10, das_per_sec: 2 },
    cost_table: { rpc: 1, das: 10, getProgramAccounts: 10, getTransactionsForAddress: 10, parsed_events: 10, enhanced_tx: 100 },
  },
  { id: 'dexscreener', name: 'DexScreener', kind: 'free', unit: '次', rate_limit: { per_min: 300, min_interval_ms: 250 } },
  { id: 'geckoterminal', name: 'GeckoTerminal', kind: 'free', unit: '次', rate_limit: { per_min: 30, min_interval_ms: 2100 } },
  { id: 'defillama', name: 'DefiLlama', kind: 'free', unit: '次', rate_limit: { min_interval_ms: 300 } },
]

const DEFAULT_SETTINGS = {
  surf_budget: {
    monthly: 1800, // 每月数据点数预算
    auto_ratio: 0.7, // 自动任务可用的日预算比例，剩余留给手动和突发
    stage_caps: { discovery: 3, screening: 8, deep_research: 30, tge_watch_extra: 15 }, // 单项目全程上限（累计）
  },
  helius_budget: { warn: 0.7, pause_nonessential: 0.85, manual_only: 0.95, stop: 1.0 },
  coverage_weights: DEFAULT_COVERAGE_WEIGHTS,
  score_version: 'v1.0',
  robinhood_review_gate: { enabled: true, validity_days: 14, tge_window_days: 30, tge_validity_days: 7 },
}

let seeded = null
function ensureSeeded() {
  if (!seeded) {
    seeded = (async () => {
      for (const c of DEFAULT_CHAINS) await insertIfMissing('chain', c.id, c)
      for (const p of DEFAULT_PROVIDERS) await insertIfMissing('provider', p.id, p)
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await insertIfMissing('setting', k, v)
    })().catch((e) => { seeded = null; throw e })
  }
  return seeded
}

async function insertIfMissing(kind, key, value) {
  await db.query(
    'INSERT INTO wr_registry (kind, key, value) VALUES ($1, $2, $3) ON CONFLICT (kind, key) DO NOTHING',
    [kind, key, JSON.stringify(value)],
  )
}

async function list(kind) {
  await ensureSeeded()
  const rows = await db.query('SELECT key, value, updated_at FROM wr_registry WHERE kind = $1', [kind])
  return rows.map((r) => ({ ...r.value, key: r.key, updated_at: r.updated_at }))
}

async function get(kind, key) {
  await ensureSeeded()
  const r = await db.one('SELECT value FROM wr_registry WHERE kind = $1 AND key = $2', [kind, key])
  return r ? r.value : null
}

async function set(kind, key, value) {
  await db.query(
    `INSERT INTO wr_registry (kind, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (kind, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [kind, key, JSON.stringify(value)],
  )
}

// 局部更新（数据源状态等）
async function patch(kind, key, partial) {
  await db.query(
    `UPDATE wr_registry SET value = value || $3::jsonb, updated_at = now() WHERE kind = $1 AND key = $2`,
    [kind, key, JSON.stringify(partial)],
  )
}

const getSetting = (k) => get('setting', k)

// 链能力上限：按权重计算的链上覆盖率（0–1）
function chainCoverage(chain, weights = DEFAULT_COVERAGE_WEIGHTS) {
  let total = 0
  const breakdown = {}
  for (const [dim, w] of Object.entries(weights)) {
    const lvl = chain.capabilities?.[dim]?.level || 'none'
    const f = LEVEL_FACTOR[lvl] ?? 0
    breakdown[dim] = { level: lvl, weight: w, contribution: +(w * f).toFixed(3) }
    total += w * f
  }
  return { coverage: +total.toFixed(3), breakdown }
}

module.exports = { ensureSeeded, list, get, set, patch, getSetting, chainCoverage, LEVEL_FACTOR, DEFAULT_SETTINGS }
