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
}
export const STAGE_ORDER = [
  'discovered', 'pending_verify', 'data_incomplete', 'data_conflict', 'screening', 'deep_research', 'watch',
  'tge_plan', 'tge_exec', 'holding', 'exited', 'review', 'rejected',
]
export const AUTO_STAGES = new Set(['discovered', 'pending_verify', 'data_incomplete', 'data_conflict', 'screening'])

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
