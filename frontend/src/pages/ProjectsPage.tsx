import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime, fmtAgo } from '@/lib/fetcher'
import { CHAINS, STAGE_LABEL, STAGE_ORDER, IDENTITY_LABEL, SOURCE_LABEL, TGE_LABEL, FRESHNESS_LABEL, chainText } from '@/lib/labels'

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
}
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
  const [stage, setStage] = useState('')
  const [chain, setChain] = useState('')
  const [source, setSource] = useState('')
  const [identity, setIdentity] = useState('')
  const [signal, setSignal] = useState('')
  const [sort, setSort] = useState('first_seen')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)

  const params = new URLSearchParams()
  for (const [k, v] of Object.entries({ stage, chain, source, identity, signal, sort, q })) if (v) params.set(k, v)
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
            前 5 个阶段由规则自动判断；进入深度尽调及之后的阶段需人工设定。初筛需满足至少 1 个硬条件 + 1 个加分条件，且证据涉及至少 2 类数据。
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
                          <div className="text-[11px] text-fg-muted">{p.stage_source === 'manual' ? '人工设定' : '自动'}</div>
                        </td>
                        <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{p.signal_label ?? '—'}</td>
                        <td className="py-2 pr-3 whitespace-nowrap" title={id.tip}><span className={id.cls}>{id.text}</span></td>
                        <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{chainText(p.chains)}</td>
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
