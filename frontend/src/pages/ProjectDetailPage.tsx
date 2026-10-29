import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime, fmtAgo } from '@/lib/fetcher'
import {
  STAGE_LABEL, STAGE_ORDER, IDENTITY_LABEL, SOURCE_LABEL, TGE_LABEL, LINK_LABEL, CONFIDENCE_LABEL, ID_TYPE_LABEL, FRESHNESS_LABEL, chainText,
  CHAINS, MATURITY_LABEL, CHAIN_STATUS_LABEL, CHAIN_SOURCE_LABEL, GROUP_LABEL, LISTING_LABEL, SNAPSHOT_TYPE_LABEL,
} from '@/lib/labels'

interface Evidence {
  condition: string; evidence_type?: string | null; evidence_provider?: string | null; evidence_source?: string | null
  evidence_record_id?: string | number | null; independence_group?: string | null; observed_at?: string | null; counted?: boolean; note?: string | null
}

interface Cond { met: boolean | null; label: string; note?: string | null }
interface Facts {
  hard?: Record<string, Cond>
  bonus?: Record<string, Cond>
  completeness?: Record<string, { met: boolean; label: string }>
  missing?: string[]
  origins?: Record<string, string[]>
  independent_sources?: number
  evidence_categories?: number
  product_evidence_level?: string | null
  rule_version?: string
  screening_rule_version?: string
  evidence?: Evidence[]
  independence_groups?: string[]
  qualifies?: boolean
  maturity?: string
  chain_status?: string
  chain_source?: string | null
  focus?: boolean
  would_be_stage?: string | null
  last_signal_at?: string | null
  listing_evidence_level?: string | null
  market_data_suggests_listed?: boolean
  campaign_chains?: string[]
  data_as_of?: string | null
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
  freshness?: string | null
  last_event_at?: string | null
  last_detail_at?: string | null
  last_metric_at?: string | null
  maturity_status?: string | null
  chain_status?: string | null
  chain_source?: string | null
  listing_evidence_level?: string | null
  campaign_chains?: string[] | null
  last_signal_at?: string | null
  reactivated_at?: string | null
  tags?: string[] | null
  flags?: string[] | null
}
interface Snapshot { id: number; rule_version: string; stage: string; stage_reason?: string | null; created_at: string; groups?: string[] | null; qualifies?: string | null; chain_status?: string | null; maturity?: string | null; snapshot_type?: string | null; data_as_of?: string | null; listing_evidence_level?: string | null }
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
  history: { id: number; from_stage?: string | null; to_stage: string; source: string; reason?: string | null; operator?: string | null; rule_version?: string | null; created_at: string }[]
  notes: { id: number; body: string; created_at: string; updated_at: string }[]
  ambiguous: { id: number; event_type: string; title?: string | null; event_at?: string | null }[]
  snapshots?: Snapshot[]
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
          {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
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

function ChainConfirm({ p, facts }: { p: Project; facts: Facts }) {
  const qc = useQueryClient()
  const status = CHAIN_STATUS_LABEL[p.chain_status ?? 'none'] ?? CHAIN_STATUS_LABEL.none
  const [picked, setPicked] = useState<string[]>(() => (p.chains ?? []).filter((c) => CHAINS.some((x) => x.id === c)))
  const [other, setOther] = useState('')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(p.chain_status !== 'core_confirmed')
  const save = useMutation({
    mutationFn: () => sendJson(`projects/${p.id}/chains`, 'POST', {
      chains: [...picked, ...other.split(/[,，\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)], note,
    }),
    onSuccess: () => { setNote(''); setOther(''); qc.invalidateQueries({ queryKey: ['project', p.id] }); qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
  const onlyChainMissing = facts.qualifies && p.chain_status !== 'core_confirmed' && ['pending_verify', 'data_incomplete', 'dormant', 'archived'].includes(p.stage)
  return (
    <Card title="所属链" desc="只有人工确认、Surf 项目详情或合约所在链算「已确认」；空投任务要求的链和从文字推断的链只是线索，不代表项目部署链。"
      right={<span className={`text-sm font-semibold ${status.cls}`} title={status.tip}>{status.text}</span>}>
      <div className="text-sm flex flex-wrap gap-x-4 gap-y-1">
        <span>当前：{chainText(p.chains)}{(p.chains ?? []).filter((c) => !CHAINS.some((x) => x.id === c)).length > 0 && <span className="text-fg-muted">（{(p.chains ?? []).join(', ')}）</span>}</span>
        <span className="text-fg-subtle">来源：{p.chain_source ? CHAIN_SOURCE_LABEL[p.chain_source] ?? p.chain_source : '—'}</span>
        {(p.campaign_chains ?? []).length > 0 && (
          <span className="text-fg-subtle" title="空投 / 任务活动要求用户去操作的链，不代表项目部署在这些链上">
            空投活动涉及的链：{(p.campaign_chains ?? []).map((c) => CHAINS.find((x) => x.id === c)?.label ?? c).join('、')}
          </span>
        )}
      </div>
      {p.chain_source === 'airdrop_task' && (
        <p className="text-sm mt-2 text-[var(--color-tag-orange-100)]">当前链只来自空投任务要求，不代表项目部署链，需要核实后才算已确认。</p>
      )}
      {onlyChainMissing && (
        <p className="text-sm mt-2 text-[var(--color-tag-yellow-100)]">证据已满足初筛条件，只差确认所属链。确认为核心链后会立即进入初筛。</p>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)} className="mt-3 text-xs text-fg-subtle hover:text-fg-base">修改所属链…</button>
      ) : (
        <div className="mt-3 flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            {CHAINS.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={picked.includes(c.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <input value={other} onChange={(e) => setOther(e.target.value)} placeholder="其他链（可选，逗号分隔，如 hyperliquid）"
              className="w-64 rounded-md border border-border-base bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:border-border-focus" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="依据（如：官网文档写明部署在 Base）"
              className="flex-1 min-w-[200px] rounded-md border border-border-base bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:border-border-focus" />
            <button onClick={() => save.mutate()} disabled={save.isPending || (!picked.length && !other.trim())}
              className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-40">
              {save.isPending ? '保存中…' : '确认所属链'}
            </button>
          </div>
          <p className="text-[11px] text-fg-muted">不消耗点数。确认后链来源记为「人工确认」，自动写一条备注留痕，并立即重新评估阶段。</p>
          {save.isError && <p className="text-xs text-destructive">{(save.error as Error).message}</p>}
        </div>
      )}
    </Card>
  )
}

function EvidenceTable({ facts }: { facts: Facts }) {
  const list = facts.evidence ?? []
  const condLabel = (k: string) => facts.hard?.[k]?.label ?? facts.bonus?.[k]?.label ?? k
  const groups = facts.independence_groups ?? []
  return (
    <Card title="证据明细"
      desc={`每条证据标注来源和独立分组；同一分组（如同一条 Surf 记录的多个字段）只算 1 个独立来源。当前独立来源：${groups.length ? groups.map((g) => GROUP_LABEL[g] ?? g).join('、') : '无'}（${groups.length} 个，需 ≥2）。`}>
      {list.length === 0 ? <p className="text-sm text-fg-subtle">暂无证据。</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1.5">条件</th>
                <th className="font-normal py-1.5">证据</th>
                <th className="font-normal py-1.5">来源</th>
                <th className="font-normal py-1.5">独立分组</th>
                <th className="font-normal py-1.5">计入</th>
                <th className="font-normal py-1.5">时间</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e, i) => (
                <tr key={i} className={`border-t border-border-base align-top ${e.counted === false ? 'text-fg-muted' : ''}`}>
                  <td className="py-1.5 pr-3">{condLabel(e.condition)}</td>
                  <td className="py-1.5 pr-3">
                    {e.evidence_type ?? '—'}
                    {e.note && <div className="text-[11px] text-fg-muted">{e.note}</div>}
                  </td>
                  <td className="py-1.5 pr-3 text-fg-subtle">
                    {e.evidence_provider ?? '—'}{e.evidence_source ? ` · ${e.evidence_source}` : ''}
                    {e.evidence_record_id != null && <div className="text-[11px] text-fg-muted font-mono">#{e.evidence_record_id}</div>}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{e.independence_group ? GROUP_LABEL[e.independence_group] ?? e.independence_group : '—'}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{e.counted === false ? '不计入' : '✓'}</td>
                  <td className="py-1.5 whitespace-nowrap text-fg-subtle">{fmtTime(e.observed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    mutationFn: (id: number) => sendJson(`projects/notes/${id}`, 'DELETE'),
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
          {p.maturity_status && <span className="text-sm text-fg-subtle">成熟度：{MATURITY_LABEL[p.maturity_status] ?? p.maturity_status}</span>}
          {p.listing_evidence_level && (
            <span className="text-sm text-fg-subtle" title={LISTING_LABEL[p.listing_evidence_level]?.tip}>
              上市证据：<span className={LISTING_LABEL[p.listing_evidence_level]?.cls}>{LISTING_LABEL[p.listing_evidence_level]?.text ?? p.listing_evidence_level}</span>
            </span>
          )}
          {(p.tags ?? []).length > 0 && <span className="text-xs text-fg-muted">{(p.tags ?? []).slice(0, 5).join(' · ')}</span>}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-fg-subtle">
          {p.website_domain && <a href={`https://${p.website_domain}`} target="_blank" rel="noreferrer" className="hover:underline">{p.website_domain}</a>}
          {p.twitter_handle && <a href={`https://x.com/${p.twitter_handle}`} target="_blank" rel="noreferrer" className="hover:underline">@{p.twitter_handle}</a>}
          <span>首次发现 {fmtTime(p.first_seen_at)}（{SOURCE_LABEL[p.discovery_source ?? ''] ?? p.discovery_source ?? '—'}）</span>
          <span>信号：{p.signal_label ?? '—'}</span>
          <span>已用 {fmtNum(Number(p.credits_spent), 1)} 点</span>
          <span>最近有效信号 {fmtAgo(p.last_signal_at)}</span>
          {p.reactivated_at && <span>重新激活于 {fmtTime(p.reactivated_at)}</span>}
          <span title={FRESHNESS_LABEL[p.freshness ?? 'expired']?.tip}>
            数据<span className={FRESHNESS_LABEL[p.freshness ?? 'expired']?.cls}>{FRESHNESS_LABEL[p.freshness ?? 'expired']?.text}</span>
            （事件 {fmtAgo(p.last_event_at)} · 详情 {fmtAgo(p.last_detail_at)} · 指标 {fmtAgo(p.last_metric_at)}）
          </span>
        </div>
        {p.description && <p className="text-sm text-fg-subtle mt-2 max-w-[900px]">{p.description}</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 flex flex-col gap-5">
          <StageControl p={p} key={`${p.stage}-${p.stage_source}`} />
          <ChainConfirm p={p} facts={facts} key={`chain-${p.chain_source}-${(p.chains ?? []).join(',')}`} />
          <Card title="初筛条件" desc={`至少 1 个硬条件 + 1 个加分条件 + ≥2 个独立来源，且所属链已确认为核心链。当前独立来源 ${facts.independence_groups?.length ?? facts.independent_sources ?? 0} 个；证据条件${facts.qualifies ? '已满足' : '未满足'}。产品证据强度：${facts.product_evidence_level === 'high' ? '高（合约 / TVL）' : facts.product_evidence_level === 'low' ? '低（仅空投任务，候选信号）' : '无'}。初筛口径 ${facts.screening_rule_version ?? '—'}。`}>
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
          <EvidenceTable facts={facts} />
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
          <Card title="初筛快照" desc="阶段或依据变化时自动记录一次。「当时运行」是系统当时真实看到的判断；「迁移重算」「人工重算」是事后用新规则重新计算的结果，不代表当时的判断。">
            {(data.snapshots ?? []).length === 0 ? <p className="text-sm text-fg-subtle">暂无快照。</p> : (
              <ul className="flex flex-col text-sm">
                {(data.snapshots ?? []).map((sn) => (
                  <li key={sn.id} className="border-t border-border-base py-1.5 first:border-t-0">
                    <div>
                      {STAGE_LABEL[sn.stage] ?? sn.stage}
                      <span className={`text-[11px] ml-1.5 px-1 rounded ${sn.snapshot_type === 'historical_runtime' ? 'text-fg-subtle' : 'text-[var(--color-tag-yellow-100)]'}`}>
                        {SNAPSHOT_TYPE_LABEL[sn.snapshot_type ?? ''] ?? sn.snapshot_type ?? '—'}
                      </span>
                      <span className="text-[11px] text-fg-muted ml-1.5">
                        {sn.rule_version} · 记录于 {fmtTime(sn.created_at)}{sn.data_as_of ? ` · 数据截至 ${fmtTime(sn.data_as_of)}` : ''}
                      </span>
                    </div>
                    <div className="text-[11px] text-fg-muted">
                      独立来源 {(sn.groups ?? []).map((g) => GROUP_LABEL[g] ?? g).join('、') || '无'}
                      {sn.chain_status ? ` · ${CHAIN_STATUS_LABEL[sn.chain_status]?.text ?? sn.chain_status}` : ''}
                      {sn.maturity ? ` · ${MATURITY_LABEL[sn.maturity] ?? sn.maturity}` : ''}
                      {sn.listing_evidence_level ? ` · ${LISTING_LABEL[sn.listing_evidence_level]?.text ?? sn.listing_evidence_level}` : ''}
                    </div>
                    {sn.stage_reason && <div className="text-[11px] text-fg-muted">{sn.stage_reason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="阶段历史">
            <ul className="flex flex-col text-sm">
              {data.history.map((h) => (
                <li key={h.id} className="border-t border-border-base py-1.5 first:border-t-0">
                  <div>
                    {h.from_stage ? `${STAGE_LABEL[h.from_stage] ?? h.from_stage} → ` : ''}{STAGE_LABEL[h.to_stage] ?? h.to_stage}
                    <span className="text-[11px] text-fg-muted ml-1.5">
                      {h.source === 'manual' ? `人工（${h.operator ?? 'self'}）` : `自动 ${h.rule_version ?? ''}`} · {fmtTime(h.created_at)}
                    </span>
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
