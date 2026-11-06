// 全站共用的中文标签
export const CHAINS: { id: string; label: string }[] = [
  { id: 'ethereum', label: 'ETH' }, { id: 'bsc', label: 'BSC' }, { id: 'base', label: 'Base' },
  { id: 'arbitrum', label: 'Arbitrum' }, { id: 'solana', label: 'SOL' }, { id: 'robinhood', label: 'Robinhood' },
]
export const CHAIN_LABEL: Record<string, string> = Object.fromEntries(CHAINS.map((c) => [c.id, c.label]))

export const STAGE_LABEL: Record<string, string> = {
  discovered: '发现', pending_verify: '待验证', data_incomplete: '数据待补全', data_conflict: '数据冲突', screening: '初筛',
  deep_research: '深度尽调', watch: '重点观察', tge_plan: 'TGE 计划', tge_exec: 'TGE 执行', holding: '持仓观察',
  exited: '退出', review: '复盘', rejected: '淘汰', merged: '已合并',
  opportunity_chain: '机会链', listed_watch: '已上市观察', non_early: '非早期项目', dormant: '休眠', archived: '归档',
}
export const STAGE_ORDER = [
  'discovered', 'pending_verify', 'data_incomplete', 'data_conflict', 'screening', 'deep_research', 'watch',
  'tge_plan', 'tge_exec', 'holding', 'exited', 'review', 'rejected',
  'opportunity_chain', 'listed_watch', 'non_early', 'dormant', 'archived',
]
export const AUTO_STAGES = new Set([
  'discovered', 'pending_verify', 'data_incomplete', 'data_conflict', 'screening',
  'opportunity_chain', 'listed_watch', 'non_early', 'dormant', 'archived',
])
// 早期池之外的阶段（M2.3）：数据保留，但不算早期研究对象
export const OUT_OF_POOL_STAGES = new Set(['opportunity_chain', 'listed_watch', 'non_early', 'dormant', 'archived'])

export const MATURITY_LABEL: Record<string, string> = {
  early: '早期', pre_tge: 'TGE 前', listed: '已上市', mature: '成熟项目', chain_infrastructure: '公链 / L2 本身', unknown: '未知',
}
export const CHAIN_STATUS_LABEL: Record<string, { text: string; cls: string; tip: string }> = {
  core_confirmed: { text: '核心链已确认', cls: 'text-fg-base', tip: '来源为人工确认、Surf 详情或合约所在链，且属于 6 条核心链' },
  other_confirmed: { text: '其他链已确认', cls: 'text-[var(--color-tag-yellow-100)]', tip: '已确认所在链，但不在 6 条核心链内' },
  inferred: { text: '链待核实', cls: 'text-[var(--color-tag-orange-100)]', tip: '链只来自空投任务要求或名称 / 描述文字推断，不代表项目部署链，需要核实' },
  none: { text: '无链信息', cls: 'text-fg-muted', tip: '没有任何所属链信息' },
}
export const CHAIN_SOURCE_LABEL: Record<string, string> = {
  manual: '人工确认', surf_detail: 'Surf 详情', contract_chain: '合约所在链', airdrop_task: '空投任务（仅线索）', inferred: '文字推断',
}
export const LISTING_LABEL: Record<string, { text: string; cls: string; tip: string }> = {
  confirmed: { text: '已确认上市', cls: 'text-fg-base', tip: '已完成 TGE，或有已确认关联的交易所上币事件' },
  market_inferred: { text: '市场推断已上市', cls: 'text-[var(--color-tag-yellow-100)]', tip: '有代币符号且流通市值达到阈值，但未确认 TGE / 上币；移出早期池，进入已上市观察' },
  inferred: { text: '可能已上市（待核实）', cls: 'text-[var(--color-tag-orange-100)]', tip: '只有市值 / FDV 数据，没有 TGE 或上币确认，暂留早期池' },
  none: { text: '无上市证据', cls: 'text-fg-muted', tip: '没有任何上市迹象' },
}
export const SNAPSHOT_TYPE_LABEL: Record<string, string> = {
  historical_runtime: '当时运行', migration_backfill: '迁移重算', manual_recalculate: '人工重算',
}
// M3 评分（草案口径）：维度 / 等级 / 红旗 / 建议
export const SCORE_DIM_LABEL: Record<string, string> = {
  funding: '融资质量', product: '产品与链上', traction: '社区热度', chain: '链归属', evidence: '证据强度', momentum: '近期动能',
}
export const TGE_DIM_LABEL: Record<string, string> = {
  token_plan: '代币计划', funding: '融资背景', community: '社区基础', listing: '上市线索', momentum: '时间窗口',
}
export const SCORE_GRADE_LABEL: Record<string, { text: string; cls: string }> = {
  A: { text: 'A', cls: 'text-[var(--color-tag-cyan-100)]' }, B: { text: 'B', cls: 'text-fg-base' },
  C: { text: 'C', cls: 'text-[var(--color-tag-yellow-100)]' }, D: { text: 'D', cls: 'text-fg-muted' },
}
export const SCORE_FLAG_LABEL: Record<string, { text: string; level: string }> = {
  lead: { text: '仅名称线索', level: 'warn' }, market_inferred: { text: '可能已上市（未确认）', level: 'warn' },
  chain_inferred: { text: '链为文字推断', level: 'warn' }, chain_missing: { text: '缺所属链', level: 'warn' },
  airdrop_chain_only: { text: '链仅来自空投任务', level: 'risk' }, no_funding: { text: '无融资记录', level: 'info' },
  no_product: { text: '无产品 / 链上证据', level: 'info' }, stale_data: { text: '数据超过时效', level: 'warn' },
  robinhood_review: { text: 'Robinhood 需人工复核', level: 'risk' }, conflict: { text: '身份冲突', level: 'risk' },
  listed: { text: '已上市', level: 'info' }, out_of_scope: { text: '不在早期池', level: 'info' }, low_confidence: { text: '置信度不足', level: 'warn' },
}
export const SCORE_RECOMMENDATION_LABEL: Record<string, { text: string; cls: string }> = {
  pending_thresholds: { text: '口径待锁定', cls: 'text-fg-subtle' },
  deep_research: { text: '建议深研', cls: 'text-[var(--color-tag-cyan-100)]' },
  watch: { text: '纳入观察', cls: 'text-fg-base' },
  skip: { text: '暂不跟进', cls: 'text-fg-muted' },
  insufficient_data: { text: '数据不足', cls: 'text-[var(--color-tag-yellow-100)]' },
  lead_only: { text: '线索（不做决策）', cls: 'text-[var(--color-tag-orange-100)]' },
  inactive: { text: '已休眠 / 归档', cls: 'text-fg-muted' },
  out_of_scope: { text: '不在早期池', cls: 'text-fg-muted' },
}
export const GROUP_LABEL: Record<string, string> = {
  surf_project: 'Surf 项目数据', surf_fundraising: 'Surf 融资数据', official_project: '官方 / 人工确认',
  onchain: '链上数据', github: 'GitHub', market_data: '市场数据', external_news: '外部新闻',
}

export const SOURCE_LABEL: Record<string, string> = {
  fundraising: '融资', public_sale: '公募', airdrop: '空投', listing: '上币', news: '新闻', tge: 'TGE',
  selftest: '自检', project_detail: '项目详情',
}
export const IDENTITY_LABEL: Record<string, { text: string; cls: string; tip: string }> = {
  confirmed: { text: '已确认', cls: 'text-fg-base', tip: '有 Surf 项目 ID 或合约地址' },
  partial: { text: '部分确认', cls: 'text-[var(--color-tag-yellow-100)]', tip: '有官网或 X 账号，但没有 Surf ID / 合约' },
  name_only: { text: '仅名称', cls: 'text-[var(--color-tag-orange-100)]', tip: '只识别出名称，身份未确认' },
}
export const TGE_LABEL: Record<string, string> = { pre: 'TGE 前', upcoming: '即将 TGE', post: '已 TGE' }
export const LINK_LABEL: Record<string, string> = {
  surf_id: 'Surf ID', name_search: '名称匹配 Surf', name: '仅名称', name_disambiguated: '同名中唯一有强身份',
  name_ambiguous: '同名歧义，待选择', manual: '人工指定', manual_none: '人工确认无对应项目', symbol: '代币符号', none: '未关联',
}
export const CONFIDENCE_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低', none: '—' }
export const ID_TYPE_LABEL: Record<string, string> = { surf_id: 'Surf ID', contract: '合约', domain: '官网', twitter: 'X 账号', name: '名称' }

export const chainText = (chains?: string[] | null) => {
  const list = (chains ?? []).filter(Boolean)
  if (!list.length) return '—'
  const core = list.filter((c) => CHAIN_LABEL[c]).map((c) => CHAIN_LABEL[c])
  const other = list.filter((c) => !CHAIN_LABEL[c])
  return [...core, ...(other.length ? [`+${other.length} 其他`] : [])].join(' · ')
}

export const FRESHNESS_LABEL: Record<string, { text: string; cls: string; tip: string }> = {
  fresh: { text: '新鲜', cls: 'text-fg-base', tip: '最近 7 天内有事件、详情或指标更新' },
  stale: { text: '需要刷新', cls: 'text-[var(--color-tag-yellow-100)]', tip: '最近一次更新在 7–30 天前' },
  expired: { text: '过期', cls: 'text-[var(--color-tag-orange-100)]', tip: '超过 30 天没有任何更新' },
  conflict: { text: '数据冲突', cls: 'text-destructive', tip: '存在待处理的身份冲突' },
}
