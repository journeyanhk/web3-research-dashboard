import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime, fmtAgo } from '@/lib/fetcher'
import { CHAINS, STAGE_LABEL, STAGE_ORDER, IDENTITY_LABEL, SOURCE_LABEL, TGE_LABEL, FRESHNESS_LABEL, MATURITY_LABEL, CHAIN_STATUS_LABEL, CHAIN_SOURCE_LABEL, LISTING_LABEL, OUT_OF_POOL_STAGES, chainText } from '@/lib/labels'

interface PoolRow {
  id: number
  name: string
  symbol?: string | null
  chains?: string[] | null
  chain_priority?: string | null
  stage: string
  stage_source: string
  stage_reason?: string | null
  stage_changed_at?: string | null
  identity_status?: string | null
  source_types?: string[] | null
  signal_label?: string | null
  completeness?: number | null
  tge_status?: string | null
  credits_spent: number
  first_seen_at: string
  last_event_at?: string | null
  website_domain?: string | null
  twitter_handle?: string | null
  event_count: number
  note_count: number
  freshness?: string | null
  last_detail_at?: string | null
  last_metric_at?: string | null
  maturity_status?: string | null
  chain_status?: string | null
  listing_evidence_level?: string | null
  chain_source?: string | null
  last_signal_at?: string | null
  reactivated_at?: string | null
  qualifies?: boolean | null
  focus?: boolean | null
  would_be_stage?: string | null
}

// 从地址读取初始筛选（雷达页的「只差确认链」等入口会带上 ?gate=）
function initialParam(name: string) {
  const qs = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(qs).get(name) ?? ''
}
const GATES: [string, string, string][] = [
  ['chain_missing', '只差确认链', '证据已满足初筛，只因所属链未确认没进初筛；进详情页可一键确认链（不花点数）'],
  ['focus', '待验证重点', '有高质量融资和产品证据，但缺所属链信息'],
]
interface PoolResponse {
  data: PoolRow[]
  total: number
  limit: number
  offset: number
  stage_counts: Record<string, number>
  signals: { signal_label: string; c: number }[]
}

const SORTS: [string, string][] = [
  ['first_seen', '首次发现'], ['last_event', '最近事件'], ['stage_changed', '阶段变更'], ['completeness', '资料完整度'], ['credits', '已用点数'],
]
const PAGE = 50

function Select({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-base bg-background px-2 py-1 text-sm text-fg-base focus:outline-none focus:border-border-focus"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
}

export default function ProjectsPage() {
  const qc = useQueryClient()
  const [stage, setStage] = useState(initialParam('stage'))
  const [gate, setGate] = useState(initialParam('gate'))
  const [maturity, setMaturity] = useState('')
  const [chainStatus, setChainStatus] = useState(initialParam('chain_status'))
  const [listing, setListing] = useState(initialParam('listing'))
  const [chain, setChain] = useState('')
  const [source, setSource] = useState('')
  const [identity, setIdentity] = useState('')
  const [signal, setSignal] = useState('')
  const [sort, setSort] = useState('first_seen')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)

  const params = new URLSearchParams()
  for (const [k, v] of Object.entries({ stage, gate, maturity, chain_status: chainStatus, listing, chain, source, identity, signal, sort, q })) if (v) params.set(k, v)
  params.set('limit', String(PAGE))
  params.set('offset', String(offset))
  const { data, isLoading, error } = useQuery({
    queryKey: ['projects', params.toString()],
    queryFn: () => getJson<PoolResponse>(`projects?${params.toString()}`),
  })
  const evaluate = useMutation({
    mutationFn: () => sendJson<{ evaluated: number; changed: unknown[] }>('projects/evaluate', 'POST'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  const counts = data?.stage_counts ?? {}
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0)
  const reset = (fn: (v: string) => void) => (v: string) => { fn(v); setOffset(0) }

  return (
    <div className="p-8 flex flex-col gap-5 max-w-[1280px]">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">项目池</h1>
          <p className="text-sm text-fg-subtle mt-1">
            初筛口径 m2.3：至少 1 个硬条件 + 1 个加分条件 + 至少 2 个独立来源（同一条记录的多个字段只算 1 个来源），且所属链已确认属于 6 条核心链。
            已上市、成熟项目和公链本身移出早期池（数据保留）；14 天无新信号休眠、30 天归档，出现新信号自动恢复。
          </p>
        </div>
        <div className="flex items-center gap-3">
          {evaluate.isSuccess && <span className="text-xs text-fg-subtle">已评估 {evaluate.data.evaluated} 个，{evaluate.data.changed.length} 个阶段变化</span>}
          <button
            onClick={() => evaluate.mutate()}
            disabled={evaluate.isPending}
            className="rounded-md border border-border-strong px-3.5 py-1.5 text-sm font-semibold hover:bg-bg-subtle-hover disabled:opacity-50"
            title="只读数据库，不消耗点数"
          >
            {evaluate.isPending ? '评估中…' : '重新评估'}
          </button>
        </div>
      </div>

      {/* 漏斗页签 */}
      <div className="flex flex-wrap gap-1.5">
        {[['', '全部', totalAll] as const, ...STAGE_ORDER.filter((s) => counts[s]).map((s) => [s, STAGE_LABEL[s], counts[s]] as const)].map(([id, label, c]) => {
          const active = stage === id
          return (
            <button
              key={id || 'all'}
              onClick={() => { setStage(id); setOffset(0) }}
              className={`rounded-md px-3 py-1 text-sm border transition-colors ${
                active ? 'border-fg-base bg-fg-base text-background font-semibold' : 'border-border-base text-fg-subtle hover:bg-bg-subtle-hover'
              }`}
            >
              {label} <span className="tabular-nums opacity-70 ml-0.5">{fmtNum(c)}</span>
            </button>
          )
        })}
      </div>

      {/* 快捷入口 */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg-muted">快捷入口</span>
        {GATES.map(([id, label, tip]) => (
          <button key={id} title={tip} onClick={() => { setGate(gate === id ? '' : id); setOffset(0) }}
            className={`rounded-md px-2.5 py-1 border ${gate === id ? 'border-fg-base bg-fg-base text-background font-semibold' : 'border-border-base text-fg-subtle hover:bg-bg-subtle-hover'}`}>
            {label}
          </button>
        ))}
        {gate && <span className="text-fg-muted">{GATES.find((g) => g[0] === gate)?.[2]}</span>}
      </div>

      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOffset(0) }}
          placeholder="搜索名称 / 代币 / 官网 / X"
          className="w-56 rounded-md border border-border-base bg-transparent px-2.5 py-1 text-sm focus:outline-none focus:border-border-focus"
        />
        <Select label="链" value={chain} onChange={reset(setChain)} options={[['', '全部'], ...CHAINS.map((c) => [c.id, c.label] as [string, string])]} />
        <Select label="来源" value={source} onChange={reset(setSource)}
          options={[['', '全部'], ['fundraising', '融资'], ['public_sale', '公募'], ['airdrop', '空投'], ['listing', '上币'], ['tge', 'TGE'], ['news', '新闻']]} />
        <Select label="身份" value={identity} onChange={reset(setIdentity)}
          options={[['', '全部'], ['confirmed', '已确认'], ['partial', '部分确认'], ['name_only', '仅名称']]} />
        <Select label="信号" value={signal} onChange={reset(setSignal)}
          options={[['', '全部'], ...(data?.signals ?? []).map((s) => [s.signal_label, `${s.signal_label}（${s.c}）`] as [string, string])]} />
        <Select label="成熟度" value={maturity} onChange={reset(setMaturity)}
          options={[['', '全部'], ...Object.entries(MATURITY_LABEL)]} />
        <Select label="链状态" value={chainStatus} onChange={reset(setChainStatus)}
          options={[['', '全部'], ...Object.entries(CHAIN_STATUS_LABEL).map(([k, v]) => [k, v.text] as [string, string])]} />
        <Select label="上市证据" value={listing} onChange={reset(setListing)}
          options={[['', '全部'], ...Object.entries(LISTING_LABEL).map(([k, v]) => [k, v.text] as [string, string])]} />
        <Select label="排序" value={sort} onChange={reset(setSort)} options={SORTS} />
      </div>

      {isLoading && <p className="text-sm text-fg-subtle">加载中…</p>}
      {error && <p className="text-sm text-destructive">加载失败：{(error as Error).message}</p>}
      {data && (
        <section className="border border-border-base rounded-lg">
          {data.data.length === 0 ? (
            <p className="text-sm text-fg-subtle p-5">没有符合条件的项目。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1140px]">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th className="font-normal py-2 pl-5">项目</th>
                    <th className="font-normal py-2">阶段</th>
                    <th className="font-normal py-2">信号</th>
                    <th className="font-normal py-2">身份</th>
                    <th className="font-normal py-2">链</th>
                    <th className="font-normal py-2 text-right">资料完整度</th>
                    <th className="font-normal py-2">数据新鲜度</th>
                    <th className="font-normal py-2">TGE</th>
                    <th className="font-normal py-2 text-right">事件</th>
                    <th className="font-normal py-2 text-right">已用点数</th>
                    <th className="font-normal py-2 pr-5">首次发现</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((p) => {
                    const id = IDENTITY_LABEL[p.identity_status ?? 'name_only'] ?? IDENTITY_LABEL.name_only
                    return (
                      <tr key={p.id} className="border-t border-border-base align-top hover:bg-bg-subtle-hover cursor-pointer"
                        onClick={() => { window.location.hash = `#/projects/${p.id}` }}>
                        <td className="py-2 pl-5 pr-3">
                          <div className="font-medium">
                            {p.name}
                            {p.symbol && <span className="text-fg-muted font-normal ml-1.5">{p.symbol}</span>}
                            {p.note_count > 0 && <span className="text-[11px] text-fg-muted font-normal ml-1.5">备注 {p.note_count}</span>}
                          </div>
                          <div className="text-[11px] text-fg-muted">
                            {(p.source_types ?? []).map((s) => SOURCE_LABEL[s] ?? s).join(' · ') || '—'}
                          </div>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap" title={p.stage_reason ?? ''}>
                          <div>{STAGE_LABEL[p.stage] ?? p.stage}</div>
                          <div className="text-[11px] text-fg-muted">
                            {p.stage_source === 'manual' ? '人工设定' : '自动'}
                            {p.would_be_stage && ` · 原 ${STAGE_LABEL[p.would_be_stage] ?? p.would_be_stage}`}
                            {p.focus && ' · 重点'}
                            {p.qualifies && p.stage !== 'screening' && !OUT_OF_POOL_STAGES.has(p.stage) && p.chain_status !== 'core_confirmed' && ' · 只差确认链'}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{p.signal_label ?? '—'}</td>
                        <td className="py-2 pr-3 whitespace-nowrap" title={id.tip}><span className={id.cls}>{id.text}</span></td>
                        <td className="py-2 pr-3 whitespace-nowrap" title={`${CHAIN_STATUS_LABEL[p.chain_status ?? 'none']?.tip ?? ''}${p.chain_source ? ` · 来源：${CHAIN_SOURCE_LABEL[p.chain_source] ?? p.chain_source}` : ''}`}>
                          <div className="text-fg-subtle">{chainText(p.chains)}</div>
                          {(() => { const c = CHAIN_STATUS_LABEL[p.chain_status ?? 'none'] ?? CHAIN_STATUS_LABEL.none; return <div className={`text-[11px] ${c.cls}`}>{c.text}</div> })()}
                          {p.maturity_status && p.maturity_status !== 'unknown' && <div className="text-[11px] text-fg-muted">{MATURITY_LABEL[p.maturity_status] ?? p.maturity_status}</div>}
                          {p.listing_evidence_level === 'inferred' && <div className="text-[11px] text-[var(--color-tag-orange-100)]" title={LISTING_LABEL.inferred.tip}>可能已上市·待核实</div>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{p.completeness != null ? `${Math.round(p.completeness * 100)}%` : '—'}</td>
                        <td className="py-2 pr-3 whitespace-nowrap" title={`最近事件 ${fmtAgo(p.last_event_at)} · 最近详情 ${fmtAgo(p.last_detail_at)} · 最近指标 ${fmtAgo(p.last_metric_at)}`}>
                          {(() => { const f = FRESHNESS_LABEL[p.freshness ?? 'expired'] ?? FRESHNESS_LABEL.expired; return <span className={f.cls}>{f.text}</span> })()}
                          <div className="text-[11px] text-fg-muted">事件 {fmtAgo(p.last_event_at)}</div>
                        </td>
                        <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{p.tge_status ? TGE_LABEL[p.tge_status] ?? p.tge_status : '—'}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.event_count)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.credits_spent, 1)}</td>
                        <td className="py-2 pr-5 text-fg-subtle whitespace-nowrap">{fmtTime(p.first_seen_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between px-5 py-3 border-t border-border-base text-xs text-fg-subtle">
            <span>共 {fmtNum(data.total)} 个 · 第 {data.total ? offset + 1 : 0}–{Math.min(offset + PAGE, data.total)} 个</span>
            <div className="flex gap-2">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}
                className="rounded-md border border-border-base px-2.5 py-1 disabled:opacity-40 hover:bg-bg-subtle-hover">上一页</button>
              <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}
                className="rounded-md border border-border-base px-2.5 py-1 disabled:opacity-40 hover:bg-bg-subtle-hover">下一页</button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
