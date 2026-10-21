import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime } from '@/lib/fetcher'

// ───────── 类型 ─────────
interface RadarProject {
  id: number
  name: string
  symbol?: string | null
  chains?: string[] | null
  chain_priority?: string | null
  discovery_source?: string | null
  first_seen_at: string
  updated_at?: string | null
  last_event_at?: string | null
  stage: string
  coverage_level: string
  credits_spent: number
  tge_status?: string | null
  website_domain?: string | null
  twitter_handle?: string | null
  event_count: number
  has_conflict: boolean
  identity_status: 'confirmed' | 'partial' | 'name_only'
}
interface RadarEvent {
  id: number
  event_type: string
  title?: string | null
  summary?: string | null
  url?: string | null
  source_name?: string | null
  importance?: number | null
  chains?: string[] | null
  candidate_name?: string | null
  candidate_symbol?: string | null
  link_method?: string | null
  link_confidence?: string | null
  event_at?: string | null
  data?: Record<string, unknown> | null
  project_id?: number | null
  project_name?: string | null
  project_chains?: string[] | null
}
interface TgeProject { id: number; name: string; symbol?: string | null; chains?: string[] | null; tge_status: string; tge_exchanges?: string[] | null; first_seen_at: string }
interface RunInfo { id: number; trigger: string; status: string; started_at: string; finished_at?: string | null; stats?: Record<string, unknown> | null; error?: string | null }
interface RadarOverview {
  chain: string | null
  summary: { new_today: number; new_7d: number; total: number; core: number; open_conflicts: number; surf_credits_today: number }
  last_run: RunInfo | null
  running: boolean
  schedule: { schedule: string; next_run_at: string | null } | null
  projects: RadarProject[]
  fundraising: RadarEvent[]
  airdrops: RadarEvent[]
  listings: RadarEvent[]
  tge: TgeProject[]
  news: RadarEvent[]
}
interface Quality {
  byType: { event_type: string; total: number; excluded: number; linked: number; projects: number }[]
  projects: { created: number; merged_away: number }
  relations: { possible: number; merged: number; different: number }
  identity: { confirmed: number; partial: number; name_only: number }
  daily: { day: string; actual: number; estimated: number; cached: number; calls: number; errors: number }[]
  providerFail: { provider: string; calls: number; errors: number }[]
  runs: { id: number; trigger: string; status: string; started_at: string; finished_at?: string | null; credits?: string | null }[]
}

// ───────── 文案 ─────────
const CHAINS: { id: string; label: string }[] = [
  { id: 'ethereum', label: 'ETH' }, { id: 'bsc', label: 'BSC' }, { id: 'base', label: 'Base' },
  { id: 'arbitrum', label: 'Arbitrum' }, { id: 'solana', label: 'SOL' }, { id: 'robinhood', label: 'Robinhood' },
]
const CHAIN_LABEL: Record<string, string> = Object.fromEntries(CHAINS.map((c) => [c.id, c.label]))
const SOURCE_LABEL: Record<string, string> = {
  fundraising: '融资', public_sale: '公募', airdrop: '空投', listing: '上币', news: '新闻', tge: 'TGE', selftest: '自检', project_detail: '项目详情',
}
const ID_LABEL: Record<string, { text: string; cls: string; tip: string }> = {
  confirmed: { text: '已确认', cls: 'text-fg-base', tip: '有 Surf 项目 ID 或合约地址' },
  partial: { text: '部分确认', cls: 'text-[var(--color-tag-yellow-100)]', tip: '有官网或 X 账号，但没有 Surf ID / 合约' },
  name_only: { text: '仅名称', cls: 'text-[var(--color-tag-orange-100)]', tip: '只从标题识别出名称，身份未确认' },
}
const TGE_LABEL: Record<string, string> = { pre: 'TGE 前', upcoming: '即将 TGE', post: '已 TGE' }
const STAGE_LABEL: Record<string, string> = { discovered: '发现', merged: '已合并' }
const AIRDROP_STATUS: Record<string, string> = {
  POTENTIAL: '潜在', CONFIRMED: '已确认', SNAPSHOT: '已快照', VERIFICATION: '验证中', REWARD_AVAILABLE: '可领取', DISTRIBUTED: '已发放',
}
const REWARD_LABEL: Record<string, string> = { airdrop: '空投', points: '积分', whitelist: '白名单', nft: 'NFT', role: '角色', ambassador: '大使' }
const LINK_LABEL: Record<string, string> = { surf_id: 'Surf ID', name_search: '名称匹配 Surf', name: '仅名称', symbol: '代币符号', none: '未关联' }
const RUN_STATUS: Record<string, string> = { ok: '成功', partial: '部分成功', error: '失败', running: '运行中' }

const fmtUsd = (n?: unknown) => {
  const v = Number(n)
  if (!v || Number.isNaN(v)) return null
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}
const fmtDay = (s?: string | null) => {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
const chainText = (chains?: string[] | null) => {
  const list = (chains ?? []).filter(Boolean)
  if (!list.length) return '—'
  const core = list.filter((c) => CHAIN_LABEL[c]).map((c) => CHAIN_LABEL[c])
  const other = list.filter((c) => !CHAIN_LABEL[c])
  return [...core, ...(other.length ? [`+${other.length} 其他`] : [])].join(' · ')
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')

// ───────── 小组件 ─────────
function Panel({ title, desc, right, children }: { title: string; desc?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border border-border-base rounded-lg min-w-0">
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {desc && <p className="text-xs text-fg-muted mt-1">{desc}</p>}
        </div>
        {right}
      </div>
      <div className="px-5 pb-4">{children}</div>
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-fg-subtle py-2">{text}</p>
}

function ExtLink({ href, children }: { href?: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="hover:underline underline-offset-2">
      {children}
    </a>
  )
}

// ───────── 区块 ─────────
function Header({ o }: { o?: RadarOverview }) {
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: () => sendJson<{ status: string; stats: { surf_credits: number } }>('radar/run', 'POST'),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['radar'] })
      qc.invalidateQueries({ queryKey: ['radar-quality'] })
    },
  })
  const last = o?.last_run
  const busy = run.isPending || o?.running
  return (
    <div className="flex items-start justify-between gap-6 flex-wrap">
      <div>
        <h1 className="text-xl font-bold">项目雷达</h1>
        <p className="text-sm text-fg-subtle mt-1">只展示新发现的项目和事件，不代表推荐。评分在 M3 上线。</p>
      </div>
      <div className="flex items-center gap-4">
        <div className="text-xs text-fg-muted text-right leading-5">
          <div>
            上次采集：{last ? `${fmtTime(last.finished_at || last.started_at)} · ${RUN_STATUS[last.status] ?? last.status}` : '尚未运行'}
            {last?.stats && typeof last.stats.surf_credits === 'number' ? ` · ${last.stats.surf_credits} 点` : ''}
          </div>
          <div>下次自动采集：{o?.schedule?.next_run_at ? fmtTime(o.schedule.next_run_at) : '—'}（每日一次）</div>
        </div>
        <button
          onClick={() => {
            if (window.confirm('立即运行一次采集？预计消耗 Surf 10–30 点（已采过的数据会走缓存）。')) run.mutate()
          }}
          disabled={!!busy}
          className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-50 shrink-0"
        >
          {busy ? '采集中…' : '立即采集'}
        </button>
      </div>
      {run.isError && <p className="w-full text-xs text-destructive">{(run.error as Error).message}</p>}
      {run.isSuccess && (
        <p className="w-full text-xs text-fg-subtle">采集完成：{RUN_STATUS[run.data.status] ?? run.data.status}，消耗 {run.data.stats?.surf_credits ?? 0} 点。</p>
      )}
    </div>
  )
}

function ChainFilter({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const opts = [{ id: null as string | null, label: '全部' }, ...CHAINS]
  return (
    <div className="flex flex-wrap gap-1.5">
      {opts.map((c) => {
        const active = value === c.id
        return (
          <button
            key={c.id ?? 'all'}
            onClick={() => onChange(c.id)}
            className={`rounded-md px-3 py-1 text-sm border transition-colors ${
              active ? 'border-fg-base bg-fg-base text-background font-semibold' : 'border-border-base text-fg-subtle hover:bg-bg-subtle-hover'
            }`}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

function SummaryRow({ s }: { s: RadarOverview['summary'] }) {
  const items: [string, string, string?][] = [
    ['今日新增项目', fmtNum(s.new_today)],
    ['近 7 天新增', fmtNum(s.new_7d)],
    ['项目总数', fmtNum(s.total), `其中核心链 ${fmtNum(s.core)}`],
    ['待判断的疑似重复', fmtNum(s.open_conflicts), '在「数据与点数」页处理'],
    ['今日采集消耗', `${fmtNum(s.surf_credits_today, 1)} 点`],
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-x-6 gap-y-4 border border-border-base rounded-lg px-5 py-4">
      {items.map(([label, value, sub]) => (
        <div key={label}>
          <div className="text-xs text-fg-subtle">{label}</div>
          <div className="text-2xl font-bold tabular-nums mt-1.5 leading-none">{value}</div>
          {sub && <div className="text-[11px] text-fg-muted mt-1.5">{sub}</div>}
        </div>
      ))}
    </div>
  )
}

function ProjectsTable({ rows }: { rows: RadarProject[] }) {
  return (
    <Panel title="新发现项目" desc="按首次发现时间排序。身份：已确认 = 有 Surf ID 或合约；部分确认 = 有官网或 X；仅名称 = 只从标题识别出名字。">
      {rows.length === 0 ? (
        <Empty text="还没有发现项目。点击右上角「立即采集」或等待每日自动采集。" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[980px]">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1.5">项目</th>
                <th className="font-normal py-1.5">链</th>
                <th className="font-normal py-1.5">来源</th>
                <th className="font-normal py-1.5">身份</th>
                <th className="font-normal py-1.5">TGE</th>
                <th className="font-normal py-1.5 text-right">事件</th>
                <th className="font-normal py-1.5">状态</th>
                <th className="font-normal py-1.5 text-right">已用点数</th>
                <th className="font-normal py-1.5">首次发现</th>
                <th className="font-normal py-1.5">最近更新</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const id = ID_LABEL[p.identity_status] ?? ID_LABEL.name_only
                return (
                  <tr key={p.id} className="border-t border-border-base align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">
                        {p.name}
                        {p.symbol && <span className="text-fg-muted font-normal ml-1.5">{p.symbol}</span>}
                      </div>
                      <div className="text-[11px] text-fg-muted">
                        {[p.website_domain, p.twitter_handle ? `@${p.twitter_handle}` : null].filter(Boolean).join(' · ') || `#${p.id}`}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{chainText(p.chains)}</td>
                    <td className="py-2 pr-3 text-fg-subtle">{SOURCE_LABEL[p.discovery_source ?? ''] ?? p.discovery_source ?? '—'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap" title={id.tip}>
                      <span className={id.cls}>{id.text}</span>
                      {p.has_conflict && <div className="text-[11px] text-[var(--color-tag-orange-100)]">疑似重复</div>}
                    </td>
                    <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{p.tge_status ? TGE_LABEL[p.tge_status] ?? p.tge_status : '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.event_count)}</td>
                    <td className="py-2 pr-3 text-fg-subtle">{STAGE_LABEL[p.stage] ?? p.stage}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(p.credits_spent, 1)}</td>
                    <td className="py-2 pr-3 text-fg-subtle whitespace-nowrap">{fmtTime(p.first_seen_at)}</td>
                    <td className="py-2 text-fg-subtle whitespace-nowrap">{fmtTime(p.updated_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function LinkNote({ e }: { e: RadarEvent }) {
  if (e.project_name) {
    return (
      <span className="text-[11px] text-fg-muted">
        → {e.project_name}（{LINK_LABEL[e.link_method ?? 'none'] ?? e.link_method}）
      </span>
    )
  }
  return <span className="text-[11px] text-fg-muted">未关联项目</span>
}

function FundraisingList({ rows }: { rows: RadarEvent[] }) {
  return (
    <Panel title="融资 / 公募" desc="重要度 ≥3 的事件会尝试确认项目身份。股票、ETF 等传统金融融资已过滤。">
      {rows.length === 0 ? <Empty text="暂无融资事件。" /> : (
        <ul className="flex flex-col">
          {rows.map((e) => {
            const d = e.data ?? {}
            const meta = [
              e.event_type === 'public_sale' ? '公募' : null,
              fmtUsd(d.amount_usd),
              typeof d.round === 'string' ? d.round : null,
              typeof d.lead === 'string' ? `领投：${d.lead}` : null,
              chainText(e.chains) !== '—' ? chainText(e.chains) : null,
            ].filter(Boolean)
            return (
              <li key={e.id} className="border-t border-border-base py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium min-w-0">
                    <ExtLink href={e.url}>{e.title}</ExtLink>
                  </div>
                  <span className="text-xs text-fg-muted shrink-0 tabular-nums">{fmtDay(e.event_at)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-fg-subtle">
                  {meta.map((m) => <span key={String(m)}>{m}</span>)}
                  {e.importance != null && <span>重要度 {e.importance}</span>}
                  <LinkNote e={e} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function AirdropList({ rows }: { rows: RadarEvent[] }) {
  return (
    <Panel title="空投 / 积分" desc="按状态更新时间排序。无 Surf 记录、无融资且社交分低的已过滤。">
      {rows.length === 0 ? <Empty text="暂无空投事件。" /> : (
        <ul className="flex flex-col">
          {rows.map((e) => {
            const d = e.data ?? {}
            const status = String(d.status ?? '')
            const meta = [
              AIRDROP_STATUS[status] ?? status,
              REWARD_LABEL[String(d.reward_type ?? '')] ?? (d.reward_type ? String(d.reward_type) : null),
              fmtUsd(d.total_raise) ? `融资 ${fmtUsd(d.total_raise)}` : null,
              Number(d.xscore) ? `社交分 ${d.xscore}` : null,
              Number(d.open_tasks) ? `${d.open_tasks} 个任务进行中` : null,
              chainText(e.chains) !== '—' ? chainText(e.chains) : null,
            ].filter(Boolean)
            return (
              <li key={e.id} className="border-t border-border-base py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium min-w-0">
                    <ExtLink href={e.url}>{e.candidate_name}</ExtLink>
                    {e.candidate_symbol && <span className="text-fg-muted font-normal ml-1.5">{e.candidate_symbol}</span>}
                  </div>
                  <span className="text-xs text-fg-muted shrink-0 tabular-nums">{fmtDay(e.event_at)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-fg-subtle">
                  {meta.map((m) => <span key={String(m)}>{m}</span>)}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function TgePanel({ tge, listings }: { tge: TgeProject[]; listings: RadarEvent[] }) {
  return (
    <Panel title="TGE / 上币" desc="TGE 状态来自项目详情；上币包含现货和盘前合约，只按代币符号关联已有项目（符号唯一时）。">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div className="text-xs text-fg-subtle mb-1">未 TGE 的项目</div>
          {tge.length === 0 ? <Empty text="暂无。" /> : (
            <ul className="flex flex-col">
              {tge.map((p) => (
                <li key={p.id} className="border-t border-border-base py-2 text-sm flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-medium">{p.name}</span>
                    {p.symbol && <span className="text-fg-muted ml-1.5">{p.symbol}</span>}
                    <div className="text-[11px] text-fg-muted">
                      {chainText(p.chains)}
                      {(p.tge_exchanges ?? []).length ? ` · 交易所：${(p.tge_exchanges ?? []).slice(0, 4).join('、')}` : ''}
                    </div>
                  </div>
                  <span className="text-xs text-fg-subtle shrink-0">{TGE_LABEL[p.tge_status] ?? p.tge_status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs text-fg-subtle mb-1">最近上币</div>
          {listings.length === 0 ? <Empty text="暂无。" /> : (
            <ul className="flex flex-col">
              {listings.map((e) => {
                const d = e.data ?? {}
                return (
                  <li key={e.id} className="border-t border-border-base py-2 text-sm flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-medium">{String(d.pair ?? e.candidate_symbol ?? '')}</span>
                      <span className="text-fg-muted ml-1.5">{String(d.exchange ?? '')}</span>
                      <span className="text-[11px] text-fg-muted ml-1.5">{String(d.product ?? '')}</span>
                      {e.project_name && <div className="text-[11px] text-fg-muted">→ {e.project_name}（代币符号）</div>}
                    </div>
                    <span className="text-xs text-fg-muted shrink-0 tabular-nums">{fmtDay(e.event_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  )
}

function NewsList({ rows }: { rows: RadarEvent[] }) {
  return (
    <Panel title="相关新闻" desc="只显示与项目池中项目相关的新闻。">
      {rows.length === 0 ? <Empty text="项目池中的项目暂无新闻。" /> : (
        <ul className="flex flex-col">
          {rows.map((e) => (
            <li key={e.id} className="border-t border-border-base py-2 text-sm flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <ExtLink href={e.url}>{e.title}</ExtLink>
                <div className="text-[11px] text-fg-muted">{e.project_name} · {e.source_name}</div>
              </div>
              <span className="text-xs text-fg-muted shrink-0 tabular-nums">{fmtDay(e.event_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

const TYPE_LABEL: Record<string, string> = { fundraising: '融资', public_sale: '公募', airdrop: '空投', listing: '上币', news: '新闻', tge: 'TGE' }

function QualityPanel() {
  const { data } = useQuery({ queryKey: ['radar-quality'], queryFn: () => getJson<Quality>('radar/quality') })
  if (!data) return null
  const created = data.projects.created
  const totalCredits = data.daily.reduce((a, d) => a + d.actual, 0)
  return (
    <Panel title="采集质量（试跑 3–7 天）" desc="用于判断是否扩大采集量。噪声 = 被过滤或无法关联的事件；有效 = 关联到项目的事件。">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1.5">事件（近 7 天）</th>
                <th className="font-normal py-1.5 text-right">总数</th>
                <th className="font-normal py-1.5 text-right">过滤</th>
                <th className="font-normal py-1.5 text-right">有效率</th>
                <th className="font-normal py-1.5 text-right">涉及项目</th>
              </tr>
            </thead>
            <tbody>
              {data.byType.map((t) => (
                <tr key={t.event_type} className="border-t border-border-base">
                  <td className="py-1.5">{TYPE_LABEL[t.event_type] ?? t.event_type}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(t.total)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(t.excluded)}</td>
                  <td className="py-1.5 text-right tabular-nums">{pct(t.linked, t.total)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(t.projects)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-3 gap-4 mt-4 text-sm">
            <div>
              <div className="text-xs text-fg-subtle">新建项目</div>
              <div className="font-semibold tabular-nums mt-1">{fmtNum(created)}</div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">身份冲突率</div>
              <div className="font-semibold tabular-nums mt-1">{pct(data.relations.possible + data.relations.different, created)}</div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">重复合并率</div>
              <div className="font-semibold tabular-nums mt-1">{pct(data.relations.merged, created)}</div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">身份已确认</div>
              <div className="font-semibold tabular-nums mt-1">{pct(data.identity.confirmed, created)}</div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">仅名称</div>
              <div className="font-semibold tabular-nums mt-1">{pct(data.identity.name_only, created)}</div>
            </div>
            <div>
              <div className="text-xs text-fg-subtle">每 100 点产出初筛项目</div>
              <div className="font-semibold mt-1 text-fg-muted">M2 后可用</div>
            </div>
          </div>
        </div>
        <div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1.5">日期</th>
                <th className="font-normal py-1.5 text-right">实际点数</th>
                <th className="font-normal py-1.5 text-right">预估点数</th>
                <th className="font-normal py-1.5 text-right">缓存命中</th>
                <th className="font-normal py-1.5 text-right">失败</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.map((d) => (
                <tr key={d.day} className="border-t border-border-base">
                  <td className="py-1.5">{d.day}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(d.actual, 1)}</td>
                  <td className="py-1.5 text-right tabular-nums text-fg-subtle">{fmtNum(d.estimated, 1)}</td>
                  <td className="py-1.5 text-right tabular-nums">{pct(d.cached, d.calls)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(d.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-fg-muted mt-2">
            近 7 天采集共 {fmtNum(totalCredits, 1)} 点 · 新建项目每个约 {created ? fmtNum(totalCredits / created, 2) : '—'} 点 · 数据源失败率：
            {data.providerFail.map((p) => ` ${p.provider} ${pct(p.errors, p.calls)}`).join('，') || ' —'}
          </p>
          <div className="text-xs text-fg-subtle mt-3 mb-1">最近运行</div>
          <ul className="text-xs text-fg-muted flex flex-col gap-0.5">
            {data.runs.map((r) => (
              <li key={r.id}>
                {fmtTime(r.started_at)} · {r.trigger === 'auto' ? '自动' : '手动'} · {RUN_STATUS[r.status] ?? r.status}
                {r.credits != null ? ` · ${r.credits} 点` : ''}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  )
}

export default function RadarPage() {
  const [chain, setChain] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['radar', chain],
    queryFn: () => getJson<RadarOverview>(`radar/overview${chain ? `?chain=${chain}` : ''}`),
  })

  return (
    <div className="p-8 flex flex-col gap-5 max-w-[1280px]">
      <Header o={data} />
      <ChainFilter value={chain} onChange={setChain} />
      {isLoading && <p className="text-sm text-fg-subtle">加载中…</p>}
      {error && <p className="text-sm text-destructive">加载失败：{(error as Error).message}</p>}
      {data && (
        <>
          <SummaryRow s={data.summary} />
          <ProjectsTable rows={data.projects} />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <FundraisingList rows={data.fundraising} />
            <AirdropList rows={data.airdrops} />
          </div>
          <TgePanel tge={data.tge} listings={data.listings} />
          <NewsList rows={data.news} />
          <QualityPanel />
        </>
      )}
    </div>
  )
}
