import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime } from '@/lib/fetcher'
import { api } from '@/lib/api'
import {
  STAGE_LABEL, STAGE_ORDER, AUTO_STAGES, IDENTITY_LABEL, SOURCE_LABEL, TGE_LABEL, LINK_LABEL, CONFIDENCE_LABEL, ID_TYPE_LABEL, chainText,
} from '@/lib/labels'

interface Cond { met: boolean | null; label: string; note?: string | null }
interface Facts {
  hard?: Record<string, Cond>
  bonus?: Record<string, Cond>
  completeness?: Record<string, { met: boolean; label: string }>
  missing?: string[]
  origins?: Record<string, string[]>
  independent_sources?: number
}
interface Project {
  id: number
  name: string
  symbol?: string | null
  chains?: string[] | null
  stage: string
  stage_source: string
  stage_reason?: string | null
  stage_changed_at?: string | null
  identity_status?: string | null
  signal_label?: string | null
  completeness?: string | number | null
  screening_facts?: Facts | null
  tge_status?: string | null
  tge_exchanges?: string[] | null
  website_domain?: string | null
  twitter_handle?: string | null
  surf_project_id?: string | null
  description?: string | null
  credits_spent: string | number
  coverage_level: string
  first_seen_at: string
  discovery_source?: string | null
  review_status?: string | null
}
interface Detail {
  project: Project
  identifiers: { id_type: string; id_value: string; source?: string | null; created_at: string }[]
  events: {
    id: number; event_type: string; title?: string | null; summary?: string | null; url?: string | null; source_name?: string | null
    importance?: number | null; link_method?: string | null; link_confidence?: string | null; excluded_reason?: string | null
    event_at?: string | null; link_evidence?: { selection_reason?: string } | null
  }[]
  metrics: { metric_name: string; value: number; unit?: string | null; source: string; fallback_used: boolean; confidence?: number | null; fetched_at: string }[]
  credits: { provider: string; task: string; calls: number; credits: number; cached: number }[]
  relations: {
    id: number; status: string; reason?: string | null; decided_by?: string | null; created_at: string; merged_at?: string | null
    other_id: number; other_name: string; other_domain?: string | null; other_twitter?: string | null
  }[]
  history: { id: number; from_stage?: string | null; to_stage: string; source: string; reason?: string | null; created_at: string }[]
  notes: { id: number; body: string; created_at: string; updated_at: string }[]
  ambiguous: { id: number; event_type: string; title?: string | null; event_at?: string | null }[]
  redirect?: number
}

const METRIC_LABEL: Record<string, string> = {
  fdv_usd: 'FDV', market_cap_usd: '流通市值', circulating_supply: '流通量', total_supply: '总供应量', twitter_followers: 'X 粉丝数', tvl_usd: 'TVL',
}
const REL_STATUS: Record<string, string> = { possible_duplicate: '疑似重复', confirmed_same: '已合并', confirmed_different: '确认不同' }

const fmtMetric = (name: string, v: number) => {
  if (name.endsWith('_usd')) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
    return `$${fmtNum(v)}`
  }
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  return fmtNum(v)
}

function Card({ title, desc, children, right }: { title: string; desc?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border border-border-base rounded-lg min-w-0">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2.5">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {desc && <p className="text-xs text-fg-muted mt-1">{desc}</p>}
        </div>
        {right}
      </div>
      <div className="px-5 pb-4">{children}</div>
    </section>
  )
}

function CondList({ items, origins }: { items?: Record<string, Cond>; origins?: Record<string, string[]> }) {
  if (!items) return <p className="text-sm text-fg-subtle">尚未评估。</p>
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {Object.entries(items).map(([k, c]) => (
        <li key={k} className="flex gap-2">
          <span className={`w-14 shrink-0 ${c.met === true ? 'text-fg-base font-semibold' : c.met === false ? 'text-fg-muted' : 'text-fg-disabled'}`}>
            {c.met === true ? '✓ 满足' : c.met === false ? '✕ 未满足' : '· 暂不评'}
          </span>
          <span className={c.met === true ? '' : 'text-fg-subtle'}>
            {c.label}
            {c.met === true && origins?.[k]?.length ? <span className="text-[11px] text-fg-muted ml-1.5">来源：{origins[k].join('、')}</span> : null}
            {c.note && <span className="text-[11px] text-fg-muted ml-1.5">{c.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function StageControl({ p }: { p: Project }) {
  const qc = useQueryClient()
  const [stage, setStage] = useState(p.stage)
  const [reason, setReason] = useState('')
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['project', p.id] })
    qc.invalidateQueries({ queryKey: ['projects'] })
  }
  const save = useMutation({
    mutationFn: () => sendJson(`projects/${p.id}/stage`, 'POST', { stage, reason }),
    onSuccess: () => { setReason(''); refresh() },
  })
  const auto = useMutation({ mutationFn: () => sendJson(`projects/${p.id}/stage`, 'POST', { mode: 'auto' }), onSuccess: refresh })
  return (
    <Card title="阶段" desc={p.stage_source === 'manual' ? '人工设定：自动规则不会再改动阶段，只会刷新下面的条件和完整度。' : '自动：采集后按规则重新判断。人工调整后改为人工设定。'}>
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-bold">{STAGE_LABEL[p.stage] ?? p.stage}</span>
        <span className="text-xs text-fg-muted">{p.stage_source === 'manual' ? '人工设定' : '自动'} · {fmtTime(p.stage_changed_at)}</span>
      </div>
      {p.stage_reason && <p className="text-sm text-fg-subtle mt-1.5">{p.stage_reason}</p>}
      <div className="flex flex-wrap items-center gap-2 mt-4">
        <select value={stage} onChange={(e) => setStage(e.target.value)}
          className="rounded-md border border-border-base bg-background px-2 py-1.5 text-sm focus:outline-none focus:border-border-focus">
          {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}{AUTO_STAGES.has(s) ? '' : ''}</option>)}
        </select>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="调整理由（必填，会记入历史）"
          className="flex-1 min-w-[200px] rounded-md border border-border-base bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:border-border-focus" />
        <button onClick={() => save.mutate()} disabled={save.isPending || !reason.trim() || stage === p.stage}
          className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-40">
          {stage === 'rejected' ? '淘汰' : '调整阶段'}
        </button>
        {p.stage_source === 'manual' && (
          <button onClick={() => auto.mutate()} disabled={auto.isPending}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:bg-bg-subtle-hover disabled:opacity-50">
            恢复自动
          </button>
        )}
      </div>
      {(save.isError || auto.isError) && <p className="text-xs text-destructive mt-2">{((save.error || auto.error) as Error).message}</p>}
    </Card>
  )
}

function Notes({ projectId, notes }: { projectId: number; notes: Detail['notes'] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['project', projectId] })
  const add = useMutation({ mutationFn: () => sendJson(`projects/${projectId}/notes`, 'POST', { body }), onSuccess: () => { setBody(''); refresh() } })
  const update = useMutation({
    mutationFn: (n: { id: number; body: string }) => sendJson(`projects/notes/${n.id}`, 'PUT', { body: n.body }),
    onSuccess: () => { setEditing(null); refresh() },
  })
  const remove = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(api(`projects/notes/${id}`), { method: 'DELETE' })
      if (!r.ok) throw new Error('删除失败')
    },
    onSuccess: refresh,
  })
  const area = 'w-full rounded-md border border-border-base bg-transparent px-2.5 py-2 text-sm focus:outline-none focus:border-border-focus'
  return (
    <Card title="研究备注" desc="只保存在你的数据库中，不会提交到代码仓库。">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="记录看法、待验证问题、下次复查要点…" className={area} />
      <div className="flex justify-end mt-2">
        <button onClick={() => add.mutate()} disabled={add.isPending || !body.trim()}
          className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-40">添加备注</button>
      </div>
      <ul className="flex flex-col mt-2">
        {notes.map((n) => (
          <li key={n.id} className="border-t border-border-base py-2.5 text-sm">
            {editing?.id === n.id ? (
              <>
                <textarea value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} rows={3} className={area} />
                <div className="flex gap-2 justify-end mt-1.5">
                  <button onClick={() => setEditing(null)} className="text-xs text-fg-subtle px-2 py-1">取消</button>
                  <button onClick={() => update.mutate(editing)} disabled={!editing.body.trim()}
                    className="rounded-md bg-fg-base text-background px-3 py-1 text-xs font-semibold disabled:opacity-40">保存</button>
                </div>
              </>
            ) : (
              <>
                <p className="whitespace-pre-wrap">{n.body}</p>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-fg-muted">
                  <span>{fmtTime(n.created_at)}{n.updated_at !== n.created_at ? `（编辑于 ${fmtTime(n.updated_at)}）` : ''}</span>
                  <button onClick={() => setEditing({ id: n.id, body: n.body })} className="hover:text-fg-base">编辑</button>
                  <button onClick={() => { if (window.confirm('删除这条备注？')) remove.mutate(n.id) }} className="hover:text-destructive">删除</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

export default function ProjectDetailPage({ id }: { id: number }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['project', id], queryFn: () => getJson<Detail>(`projects/${id}`) })
  const decide = useMutation({
    mutationFn: ({ relId, decision }: { relId: number; decision: 'same' | 'different' }) =>
      sendJson(`projects/relations/${relId}/decide`, 'POST', { decision }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project'] }); qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
  const linkHere = useMutation({
    mutationFn: (eventId: number) => sendJson(`projects/events/${eventId}/link`, 'POST', { projectId: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', id] }),
  })

  if (isLoading) return <div className="p-8 text-sm text-fg-subtle">加载中…</div>
  if (error) return <div className="p-8 text-sm text-destructive">加载失败：{(error as Error).message}</div>
  if (!data) return null
  if (data.redirect) {
    return (
      <div className="p-8 text-sm">
        该项目已并入 <a className="underline" href={`#/projects/${data.redirect}`}>#{data.redirect}</a>。
      </div>
    )
  }
  const p = data.project
  const facts = p.screening_facts ?? {}
  const idl = IDENTITY_LABEL[p.identity_status ?? 'name_only'] ?? IDENTITY_LABEL.name_only
  const completeness = p.completeness != null ? Math.round(Number(p.completeness) * 100) : null

  return (
    <div className="p-8 flex flex-col gap-5 max-w-[1280px]">
      <div>
        <a href="#/projects" className="text-xs text-fg-subtle hover:text-fg-base">← 返回项目池</a>
        <div className="flex items-baseline gap-3 mt-2 flex-wrap">
          <h1 className="text-2xl font-bold">{p.name}</h1>
          {p.symbol && <span className="text-fg-muted">{p.symbol}</span>}
          <span className={`text-sm ${idl.cls}`} title={idl.tip}>身份{idl.text}</span>
          <span className="text-sm text-fg-subtle">{chainText(p.chains)}</span>
          {p.tge_status && <span className="text-sm text-fg-subtle">{TGE_LABEL[p.tge_status] ?? p.tge_status}</span>}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-fg-subtle">
          {p.website_domain && <a href={`https://${p.website_domain}`} target="_blank" rel="noreferrer" className="hover:underline">{p.website_domain}</a>}
          {p.twitter_handle && <a href={`https://x.com/${p.twitter_handle}`} target="_blank" rel="noreferrer" className="hover:underline">@{p.twitter_handle}</a>}
          <span>首次发现 {fmtTime(p.first_seen_at)}（{SOURCE_LABEL[p.discovery_source ?? ''] ?? p.discovery_source ?? '—'}）</span>
          <span>信号：{p.signal_label ?? '—'}</span>
          <span>已用 {fmtNum(Number(p.credits_spent), 1)} 点</span>
        </div>
        {p.description && <p className="text-sm text-fg-subtle mt-2 max-w-[900px]">{p.description}</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 flex flex-col gap-5">
          <StageControl p={p} key={`${p.stage}-${p.stage_source}`} />
          <Card title="初筛条件" desc={`至少 1 个硬条件 + 1 个加分条件，且来自 ≥2 个独立来源。当前独立来源：${facts.independent_sources ?? 0} 个。`}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <div className="text-xs text-fg-subtle mb-2">硬条件</div>
                <CondList items={facts.hard} origins={facts.origins} />
              </div>
              <div>
                <div className="text-xs text-fg-subtle mb-2">加分条件</div>
                <CondList items={facts.bonus} origins={facts.origins} />
              </div>
            </div>
          </Card>
          <Card title="事件时间线" desc="关联方式与置信度说明这条事件是怎么挂到项目上的。">
            {data.events.length === 0 ? <p className="text-sm text-fg-subtle">暂无事件。</p> : (
              <ul className="flex flex-col">
                {data.events.map((e) => (
                  <li key={e.id} className="border-t border-border-base py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-sm min-w-0">
                        <span className="text-xs text-fg-muted mr-2">{SOURCE_LABEL[e.event_type] ?? e.event_type}</span>
                        {e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="hover:underline underline-offset-2">{e.title}</a> : e.title}
                      </div>
                      <span className="text-xs text-fg-muted shrink-0">{fmtTime(e.event_at)}</span>
                    </div>
                    <div className="text-[11px] text-fg-muted mt-0.5">
                      {LINK_LABEL[e.link_method ?? 'none'] ?? e.link_method} · 置信度{CONFIDENCE_LABEL[e.link_confidence ?? 'none'] ?? e.link_confidence}
                      {e.link_evidence?.selection_reason ? ` · ${e.link_evidence.selection_reason}` : ''}
                      {e.excluded_reason ? ` · 已过滤：${e.excluded_reason}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Notes projectId={p.id} notes={data.notes} />
        </div>

        <div className="flex flex-col gap-5">
          <Card title="资料完整度" right={<span className="text-xl font-bold tabular-nums">{completeness != null ? `${completeness}%` : '—'}</span>}>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              {Object.entries(facts.completeness ?? {}).map(([k, c]) => (
                <li key={k} className={c.met ? '' : 'text-fg-muted'}>{c.met ? '✓' : '✕'} {c.label}</li>
              ))}
            </ul>
          </Card>
          <Card title="身份标识">
            <ul className="flex flex-col text-sm">
              {data.identifiers.map((i) => (
                <li key={`${i.id_type}-${i.id_value}`} className="border-t border-border-base py-1.5 first:border-t-0">
                  <span className="text-xs text-fg-muted w-14 inline-block">{ID_TYPE_LABEL[i.id_type] ?? i.id_type}</span>
                  <span className="font-mono text-xs break-all">{i.id_value}</span>
                  {i.source && <span className="text-[11px] text-fg-muted ml-1.5">· {SOURCE_LABEL[i.source] ?? i.source}</span>}
                </li>
              ))}
            </ul>
          </Card>
          {(data.relations.length > 0 || data.ambiguous.length > 0) && (
            <Card title="身份冲突">
              <ul className="flex flex-col text-sm">
                {data.relations.map((r) => (
                  <li key={r.id} className="border-t border-border-base py-2 first:border-t-0">
                    <div>
                      <a href={`#/projects/${r.other_id}`} className="font-medium hover:underline">{r.other_name} #{r.other_id}</a>
                      <span className="text-xs text-fg-muted ml-1.5">{REL_STATUS[r.status] ?? r.status}</span>
                    </div>
                    <div className="text-[11px] text-fg-muted">{r.reason}</div>
                    {r.status === 'possible_duplicate' && (
                      <div className="flex gap-2 mt-1.5">
                        <button disabled={decide.isPending} onClick={() => decide.mutate({ relId: r.id, decision: 'same' })}
                          className="rounded-md bg-fg-base text-background px-2.5 py-1 text-xs font-semibold disabled:opacity-50">是同一项目，合并</button>
                        <button disabled={decide.isPending} onClick={() => decide.mutate({ relId: r.id, decision: 'different' })}
                          className="rounded-md border border-border-strong px-2.5 py-1 text-xs hover:bg-bg-subtle-hover disabled:opacity-50">不同项目</button>
                      </div>
                    )}
                  </li>
                ))}
                {data.ambiguous.map((e) => (
                  <li key={`a${e.id}`} className="border-t border-border-base py-2 first:border-t-0">
                    <div className="text-xs text-fg-muted">同名歧义事件</div>
                    <div>{e.title}</div>
                    <button disabled={linkHere.isPending} onClick={() => linkHere.mutate(e.id)}
                      className="mt-1.5 rounded-md border border-border-strong px-2.5 py-1 text-xs hover:bg-bg-subtle-hover disabled:opacity-50">关联到本项目</button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="代币与社交数据" desc="来自项目详情，只追加不覆盖。">
            {data.metrics.length === 0 ? <p className="text-sm text-fg-subtle">暂无。</p> : (
              <ul className="flex flex-col text-sm">
                {data.metrics.map((m) => (
                  <li key={m.metric_name} className="flex justify-between gap-3 border-t border-border-base py-1.5 first:border-t-0">
                    <span className="text-fg-subtle">{METRIC_LABEL[m.metric_name] ?? m.metric_name}</span>
                    <span className="text-right">
                      <span className="tabular-nums font-medium">{fmtMetric(m.metric_name, m.value)}</span>
                      <div className="text-[11px] text-fg-muted">
                        {m.source}{m.fallback_used ? '（备用源）' : ''} · {fmtTime(m.fetched_at)}
                      </div>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="点数消耗">
            {data.credits.length === 0 ? <p className="text-sm text-fg-subtle">还没有为该项目单独花过点数。</p> : (
              <table className="w-full text-sm">
                <tbody>
                  {data.credits.map((c) => (
                    <tr key={`${c.provider}-${c.task}`} className="border-t border-border-base first:border-t-0">
                      <td className="py-1.5">{c.provider} · {c.task}</td>
                      <td className="py-1.5 text-right tabular-nums text-fg-subtle">{c.calls} 次{c.cached ? `（缓存 ${c.cached}）` : ''}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtNum(c.credits, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="阶段历史">
            <ul className="flex flex-col text-sm">
              {data.history.map((h) => (
                <li key={h.id} className="border-t border-border-base py-1.5 first:border-t-0">
                  <div>
                    {h.from_stage ? `${STAGE_LABEL[h.from_stage] ?? h.from_stage} → ` : ''}{STAGE_LABEL[h.to_stage] ?? h.to_stage}
                    <span className="text-[11px] text-fg-muted ml-1.5">{h.source === 'manual' ? '人工' : '自动'} · {fmtTime(h.created_at)}</span>
                  </div>
                  {h.reason && <div className="text-[11px] text-fg-muted">{h.reason}</div>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
