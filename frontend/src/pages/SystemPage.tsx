import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime } from '@/lib/fetcher'

type Level = 'full' | 'partial' | 'inferred' | 'none'
interface Capability { level?: Level; source?: string | null; note?: string }
interface Chain {
  key: string
  name: string
  tier: string
  status: string
  notes?: string
  capabilities?: Record<string, Capability>
  coverage: number
}
interface ProviderStats {
  calls_today: number
  calls_7d: number
  cached_7d: number
  errors_7d: number
  blocked_7d: number
  rate_limited_7d: number
  avg_ms_7d: number
  credits_month: number
}
interface Provider {
  key: string
  name: string
  kind: string
  unit: string
  monthly_quota?: number | null
  last_success_at?: string | null
  last_error_at?: string | null
  last_error?: string | null
  stats: ProviderStats | null
}
interface SurfBudget { monthly: number; monthUsed: number; todayAuto: number; todayAll: number; dailyAutoCap: number; autoRatio: number }
interface HeliusBudget { quota: number; used: number; ratio: number; level: string }
interface SelftestResult { group: string; name: string; ok: boolean | null; detail: string; ms?: number }
interface Selftest { ran_at: string; passed: number; failed: number; results: SelftestResult[] }
interface SurfBudgetSetting { monthly: number; auto_ratio: number; stage_total_caps: Record<string, number> }
interface EndpointStat { provider: string; endpoint: string; calls: number; cached: number; ok: number; errors: number; est_credits: number; actual_credits: number }
interface RelProject { id: number; name: string; symbol?: string | null; website_domain?: string | null; twitter_handle?: string | null; chains?: string[] | null }
interface Relation { id: number; status: string; reason?: string | null; created_at: string; project_a: RelProject; project_b: RelProject }
interface Overview {
  chains: Chain[]
  providers: Provider[]
  budget: { surf: SurfBudget; helius: HeliusBudget; byTask: { task: string; trigger: string; credits: number; calls: number }[]; byEndpoint: EndpointStat[] }
  settings: {
    surf_budget: SurfBudgetSetting; score_version: string; robinhood_review_gate: { enabled: boolean; validity_days: number; tge_validity_days: number }
    pipeline_config?: PipelineConfig
  }
  counts: { open_alerts: number; projects: number }
  last_selftest: Selftest | null
}
interface UsageRow {
  id: number
  provider: string
  endpoint: string
  trigger: string
  task: string | null
  status: string
  credits: number
  estimated_credits: number | null
  duration_ms: number | null
  error: string | null
  created_at: string
}

const TIER_LABEL: Record<string, string> = { A: 'A 完整自动', B: 'B 部分自动', C: 'C 事件驱动', X: '暂停' }
const STATUS_LABEL: Record<string, string> = {
  uncovered: '未覆盖', signal: '发现信号', trial: '临时观察', core: '核心监控', downgraded: '降级观察', paused: '暂停',
}
const LEVEL_LABEL: Record<Level, string> = { full: '完整', partial: '部分', inferred: '推算', none: '无' }
const LEVEL_CLASS: Record<Level, string> = {
  full: 'text-fg-base',
  partial: 'text-[var(--color-tag-yellow-100)]',
  inferred: 'text-[var(--color-tag-orange-100)]',
  none: 'text-fg-disabled',
}
const DIMS: { key: string; label: string }[] = [
  { key: 'holders', label: '持仓' },
  { key: 'dex', label: 'DEX' },
  { key: 'activity', label: '活跃' },
  { key: 'flows', label: '资金流' },
  { key: 'tvl', label: 'TVL' },
  { key: 'tokenomics', label: '解锁' },
]
const KIND_LABEL: Record<string, string> = { paid: '付费点数', free_quota: '免费额度', free: '免费' }
const TRIGGER_LABEL: Record<string, string> = { auto: '自动', manual: '手动', selftest: '自检' }
const USAGE_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: '成功', cls: 'text-fg-base' },
  cached: { label: '缓存', cls: 'text-fg-subtle' },
  error: { label: '失败', cls: 'text-destructive' },
  blocked: { label: '已拦截', cls: 'text-[var(--color-tag-orange-100)]' },
}
const HELIUS_LEVEL: Record<string, string> = {
  normal: '正常', warn: '已过 70% 提示线', paused_nonessential: '≥85% 已暂停非必要任务', manual_only: '≥95% 仅手动', stopped: '已用完',
}

function Section({ title, desc, children, right }: { title: string; desc?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border border-border-base rounded-lg">
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {desc && <p className="text-xs text-fg-muted mt-1">{desc}</p>}
        </div>
        {right}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  )
}

// 单值进度条：轨道 + 填充，超过阈值时切换为状态色并附文字说明
function Meter({ value, max, warnAt = 0.7, critAt = 0.9 }: { value: number; max: number; warnAt?: number; critAt?: number }) {
  const r = max > 0 ? Math.min(1, value / max) : 0
  const color = r >= critAt ? 'var(--destructive)' : r >= warnAt ? 'var(--color-tag-orange-100)' : 'var(--fg-base)'
  return (
    <div className="h-1.5 w-full rounded-full bg-bg-subtle overflow-hidden" role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(r * 100, value > 0 ? 1.5 : 0)}%`, background: color }} />
    </div>
  )
}

function Stat({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="text-2xl font-bold tabular-nums leading-none">{value}</div>
      {children}
      {sub && <div className="text-xs text-fg-muted">{sub}</div>}
    </div>
  )
}

function BudgetPanel({ o }: { o: Overview }) {
  const s = o.budget.surf
  const h = o.budget.helius
  const dayOfMonth = new Date().getDate()
  const projected = dayOfMonth > 0 ? (s.monthUsed / dayOfMonth) * 30 : 0
  return (
    <Section title="点数与额度" desc="Surf 点数、Helius 额度、免费数据源分开记账。页面浏览只读数据库，不消耗点数。">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Stat label="Surf 本月已用" value={`${fmtNum(s.monthUsed, 1)} / ${fmtNum(s.monthly)}`} sub={`按当前速度，月底约 ${fmtNum(projected)} 点`}>
          <Meter value={s.monthUsed} max={s.monthly} warnAt={0.8} critAt={0.95} />
        </Stat>
        <Stat label="今日自动任务" value={`${fmtNum(s.todayAuto, 1)} / ${fmtNum(s.dailyAutoCap, 1)}`} sub={`今日合计 ${fmtNum(s.todayAll, 1)} 点；剩余 ${Math.round((1 - s.autoRatio) * 100)}% 留给手动和突发`}>
          <Meter value={s.todayAuto} max={s.dailyAutoCap} warnAt={0.8} critAt={1} />
        </Stat>
        <Stat label="Helius 本月已用" value={`${fmtNum(h.used)} / ${fmtNum(h.quota)}`} sub={`状态：${HELIUS_LEVEL[h.level] ?? h.level}`}>
          <Meter value={h.used} max={h.quota} warnAt={0.7} critAt={0.85} />
        </Stat>
      </div>
      {o.budget.byTask.length > 0 && (
        <div className="mt-5">
          <div className="text-xs text-fg-subtle mb-2">本月 Surf 点数去向</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1">任务</th>
                <th className="font-normal py-1">触发</th>
                <th className="font-normal py-1 text-right">调用</th>
                <th className="font-normal py-1 text-right">点数</th>
              </tr>
            </thead>
            <tbody>
              {o.budget.byTask.map((t) => (
                <tr key={`${t.task}-${t.trigger}`} className="border-t border-border-base">
                  <td className="py-1.5">{t.task}</td>
                  <td className="py-1.5 text-fg-subtle">{TRIGGER_LABEL[t.trigger] ?? t.trigger}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(t.calls)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(t.credits, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function ChainMatrix({ chains }: { chains: Chain[] }) {
  return (
    <Section title="链能力矩阵" desc="覆盖率 = 持仓 25% + DEX 25% + 活跃 20% + 资金流 20% + TVL 10%（完整计 1、部分计 0.5、推算不计入）。这是链的能力上限，单个项目的实际覆盖率在评分时另算。">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="font-normal py-1.5">链</th>
              <th className="font-normal py-1.5">层级</th>
              <th className="font-normal py-1.5">状态</th>
              {DIMS.map((d) => <th key={d.key} className="font-normal py-1.5">{d.label}</th>)}
              <th className="font-normal py-1.5 text-right">覆盖率</th>
            </tr>
          </thead>
          <tbody>
            {chains.map((c) => (
              <tr key={c.key} className="border-t border-border-base align-top">
                <td className="py-2 font-medium">
                  {c.name}
                  {c.notes && <div className="text-[11px] text-fg-muted font-normal mt-0.5">{c.notes}</div>}
                </td>
                <td className="py-2 text-fg-subtle">{TIER_LABEL[c.tier] ?? c.tier}</td>
                <td className="py-2 text-fg-subtle">{STATUS_LABEL[c.status] ?? c.status}</td>
                {DIMS.map((d) => {
                  const cap = c.capabilities?.[d.key]
                  const lvl = (cap?.level ?? 'none') as Level
                  return (
                    <td key={d.key} className="py-2" title={[cap?.source, cap?.note].filter(Boolean).join(' · ')}>
                      <span className={LEVEL_CLASS[lvl]}>{LEVEL_LABEL[lvl]}</span>
                      {cap?.source && lvl !== 'none' && <div className="text-[11px] text-fg-muted">{cap.source}</div>}
                    </td>
                  )
                })}
                <td className="py-2 text-right tabular-nums font-semibold">{c.status === 'paused' ? '—' : `${Math.round(c.coverage * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

function ProvidersTable({ providers }: { providers: Provider[] }) {
  return (
    <Section title="数据源状态" desc="近 7 天统计。遇到限流会自动退避重试；主源失败切到备用源时会在指标上标记。">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="font-normal py-1.5">数据源</th>
              <th className="font-normal py-1.5">类型</th>
              <th className="font-normal py-1.5 text-right">今日调用</th>
              <th className="font-normal py-1.5 text-right">缓存命中</th>
              <th className="font-normal py-1.5 text-right">失败</th>
              <th className="font-normal py-1.5 text-right">限流</th>
              <th className="font-normal py-1.5 text-right">平均耗时</th>
              <th className="font-normal py-1.5">最近成功</th>
              <th className="font-normal py-1.5">最近失败</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const s = p.stats
              const hit = s && s.calls_7d ? `${Math.round((s.cached_7d / s.calls_7d) * 100)}%` : '—'
              return (
                <tr key={p.key} className="border-t border-border-base align-top">
                  <td className="py-2 font-medium">{p.name}</td>
                  <td className="py-2 text-fg-subtle">{KIND_LABEL[p.kind] ?? p.kind}</td>
                  <td className="py-2 text-right tabular-nums">{fmtNum(s?.calls_today ?? 0)}</td>
                  <td className="py-2 text-right tabular-nums">{hit}</td>
                  <td className="py-2 text-right tabular-nums">{fmtNum(s?.errors_7d ?? 0)}</td>
                  <td className="py-2 text-right tabular-nums">{fmtNum(s?.rate_limited_7d ?? 0)}</td>
                  <td className="py-2 text-right tabular-nums">{s?.avg_ms_7d ? `${fmtNum(s.avg_ms_7d)} ms` : '—'}</td>
                  <td className="py-2 text-fg-subtle">{fmtTime(p.last_success_at)}</td>
                  <td className="py-2 text-fg-subtle" title={p.last_error ?? ''}>
                    {fmtTime(p.last_error_at)}
                    {p.last_error && <div className="text-[11px] text-fg-muted truncate max-w-[200px]">{p.last_error}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

interface PipelineConfig { dormant_days: number; archive_days: number; mature_market_cap_usd: number; mature_fdv_usd: number }
interface BackfillResult {
  skipped?: boolean; reason?: string; dryRun?: boolean; candidates?: number; estimated_credits_max?: number
  status?: string; stats?: { surf_credits?: number; identity_backfill?: Record<string, number>; detail?: Record<string, number> }
  error?: string
}

function IdentityBackfill() {
  const qc = useQueryClient()
  const [preview, setPreview] = useState<BackfillResult | null>(null)
  const dry = useMutation({
    mutationFn: () => sendJson<BackfillResult>('radar/identity-backfill', 'POST', { limit: 50, dryRun: true }),
    onSuccess: setPreview,
  })
  const run = useMutation({
    mutationFn: () => sendJson<BackfillResult>('radar/identity-backfill', 'POST', { limit: 50 }),
    onSuccess: () => { setPreview(null); qc.invalidateQueries() },
  })
  const r = run.data
  const bf = r?.stats?.identity_backfill ?? {}
  return (
    <Section title="身份补全（一次性）"
      desc="对只有名称、从没在 Surf 搜过的项目各搜一次：唯一匹配 → 补全身份并重新评估；多个同名 → 放入待确认，不自动选；查不到 → 标记，出现新信号前不再付费查询。每日采集也会自动复查最多 5 个有新信号的项目。">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => dry.mutate()} disabled={dry.isPending || run.isPending}
          className="rounded-md border border-border-strong px-3.5 py-1.5 text-sm hover:bg-bg-subtle-hover disabled:opacity-50">
          {dry.isPending ? '计算中…' : '查看候选与预计点数'}
        </button>
        {preview && !preview.skipped && (
          <>
            <span className="text-sm">候选 {fmtNum(preview.candidates ?? 0)} 个，预计最多 {fmtNum(preview.estimated_credits_max ?? 0)} 点（搜索 1 点 / 个，找到的再取详情约 1 点）</span>
            <button onClick={() => { if (window.confirm(`确认执行身份补全？预计最多消耗 ${preview.estimated_credits_max ?? 0} 点。`)) run.mutate() }}
              disabled={run.isPending}
              className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-50">
              {run.isPending ? '执行中…' : '执行'}
            </button>
          </>
        )}
        {preview?.skipped && <span className="text-sm text-fg-subtle">{preview.reason ?? '没有需要补全的项目'}</span>}
      </div>
      {r && (
        <p className="text-sm mt-3">
          {r.skipped ? (r.reason ?? '已跳过') : `完成：搜索 ${bf.searched ?? 0} 个，唯一匹配 ${bf.found ?? 0}，同名多个 ${bf.ambiguous ?? 0}，查不到 ${bf.not_found ?? 0}；消耗 ${fmtNum(Number(r.stats?.surf_credits ?? 0), 1)} 点。`}
        </p>
      )}
      {(dry.isError || run.isError) && <p className="text-xs text-destructive mt-2">{((dry.error || run.error) as Error).message}</p>}
    </Section>
  )
}

function PipelineSettings({ setting }: { setting: PipelineConfig }) {
  const qc = useQueryClient()
  const [dormant, setDormant] = useState(String(setting.dormant_days))
  const [archive, setArchive] = useState(String(setting.archive_days))
  const [mcap, setMcap] = useState(String(setting.mature_market_cap_usd / 1e6))
  const [fdv, setFdv] = useState(String(setting.mature_fdv_usd / 1e6))
  const save = useMutation({
    mutationFn: () => sendJson('system/settings/pipeline_config', 'PUT', {
      value: { dormant_days: Number(dormant), archive_days: Number(archive), mature_market_cap_usd: Number(mcap) * 1e6, mature_fdv_usd: Number(fdv) * 1e6 },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-overview'] }),
  })
  const input = 'w-full rounded-md border border-border-base bg-transparent px-2.5 py-1.5 text-sm tabular-nums focus:outline-none focus:border-border-focus'
  return (
    <Section title="早期池规则" desc="保存后在下次评估（每日采集后，或项目池「重新评估」）生效。成熟项目 = 已上市且市值或 FDV 超过阈值。">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">无新信号多少天休眠<input className={input} value={dormant} onChange={(e) => setDormant(e.target.value)} inputMode="numeric" /></label>
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">无新信号多少天归档<input className={input} value={archive} onChange={(e) => setArchive(e.target.value)} inputMode="numeric" /></label>
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">成熟市值阈值（百万美元）<input className={input} value={mcap} onChange={(e) => setMcap(e.target.value)} inputMode="numeric" /></label>
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">成熟 FDV 阈值（百万美元）<input className={input} value={fdv} onChange={(e) => setFdv(e.target.value)} inputMode="numeric" /></label>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-50">{save.isPending ? '保存中…' : '保存'}</button>
        {save.isSuccess && <span className="text-xs text-fg-subtle">已保存</span>}
        {save.isError && <span className="text-xs text-destructive">{(save.error as Error).message}</span>}
      </div>
    </Section>
  )
}

function BudgetSettings({ setting }: { setting: SurfBudgetSetting }) {
  const qc = useQueryClient()
  const [monthly, setMonthly] = useState(String(setting.monthly))
  const [ratio, setRatio] = useState(String(Math.round(setting.auto_ratio * 100)))
  const [caps, setCaps] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(setting.stage_total_caps ?? {}).map(([k, v]) => [k, String(v)])),
  )
  const save = useMutation({
    mutationFn: () =>
      sendJson('system/settings/surf_budget', 'PUT', {
        value: {
          monthly: Number(monthly),
          auto_ratio: Number(ratio) / 100,
          stage_total_caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, Number(v)])),
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-overview'] }),
  })
  const CAP_LABEL: Record<string, string> = { discovery: '发现', screening: '初筛', deep_research: '深度尽调', tge_watch: 'TGE 观察' }
  const CAP_ORDER = ['discovery', 'screening', 'deep_research', 'tge_watch']
  const input = 'w-full rounded-md border border-border-base bg-transparent px-2.5 py-1.5 text-sm tabular-nums focus:outline-none focus:border-border-focus'
  return (
    <Section title="预算设置" desc="自动任务每日上限 = 月预算 ÷ 30 × 自动比例。单项目上限是从发现起的全程累计值（升级阶段不会额外叠加），超过后自动任务停止为该项目补数据。">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">
          月预算（点）
          <input className={input} value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="numeric" />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-fg-subtle">
          自动比例（%）
          <input className={input} value={ratio} onChange={(e) => setRatio(e.target.value)} inputMode="numeric" />
        </label>
        {CAP_ORDER.filter((k) => k in caps).map((k) => (
          <label key={k} className="flex flex-col gap-1.5 text-xs text-fg-subtle">
            {CAP_LABEL[k] ?? k}·累计上限
            <input className={input} value={caps[k]} onChange={(e) => setCaps({ ...caps, [k]: e.target.value })} inputMode="numeric" />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-md bg-fg-base text-background px-3.5 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          {save.isPending ? '保存中…' : '保存'}
        </button>
        {save.isSuccess && <span className="text-xs text-fg-subtle">已保存</span>}
        {save.isError && <span className="text-xs text-destructive">{(save.error as Error).message}</span>}
      </div>
    </Section>
  )
}

function SelftestPanel({ last }: { last: Selftest | null }) {
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: () => sendJson<Selftest>('system/selftest', 'POST'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-overview'] })
      qc.invalidateQueries({ queryKey: ['system-usage'] })
      qc.invalidateQueries({ queryKey: ['relations'] })
    },
  })
  const data = run.data ?? last
  return (
    <Section
      title="验收自检"
      desc="使用真实数据验证密钥与数据库、记账与存档、缓存、备用源切换、项目去重与合并、预算拦截。临时数据会自动清理。每次约消耗 Surf 1–2 点、Helius 10 credits。"
      right={
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="shrink-0 rounded-md border border-border-strong px-3.5 py-1.5 text-sm font-semibold hover:bg-bg-subtle-hover disabled:opacity-50"
        >
          {run.isPending ? '自检中…' : '运行自检'}
        </button>
      }
    >
      {run.isError && <p className="text-sm text-destructive mb-3">{(run.error as Error).message}</p>}
      {!data ? (
        <p className="text-sm text-fg-subtle">还没有运行过自检。</p>
      ) : (
        <>
          <p className="text-xs text-fg-muted mb-3">
            {fmtTime(data.ran_at)} · 通过 {data.passed} 项 · 失败 {data.failed} 项
          </p>
          <ul className="flex flex-col">
            {data.results.map((r, i) => (
              <li key={i} className="flex gap-3 border-t border-border-base py-2 text-sm">
                <span className={`w-12 shrink-0 font-semibold ${r.ok === true ? 'text-fg-base' : r.ok === false ? 'text-destructive' : 'text-fg-muted'}`}>
                  {r.ok === true ? '✓ 通过' : r.ok === false ? '✕ 失败' : '待 M3'}
                </span>
                <span className="w-10 shrink-0 text-fg-muted">{r.group}</span>
                <span className="w-56 shrink-0">{r.name}</span>
                <span className="text-fg-subtle break-all">{r.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  )
}

function EndpointStats({ rows }: { rows: EndpointStat[] }) {
  return (
    <Section title="按接口统计" desc="近 7 天。缓存时间设置不合理是最容易浪费点数的地方，重点看缓存命中率和预估与实际的偏差。">
      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle">暂无调用记录。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1.5">数据源</th>
                <th className="font-normal py-1.5">接口</th>
                <th className="font-normal py-1.5 text-right">调用</th>
                <th className="font-normal py-1.5 text-right">缓存命中</th>
                <th className="font-normal py-1.5 text-right">失败</th>
                <th className="font-normal py-1.5 text-right">预估消耗</th>
                <th className="font-normal py-1.5 text-right">实际消耗</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const diff = r.actual_credits - r.est_credits
                return (
                  <tr key={`${r.provider}-${r.endpoint}`} className="border-t border-border-base">
                    <td className="py-1.5">{r.provider}</td>
                    <td className="py-1.5 font-mono text-xs">{r.endpoint}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtNum(r.calls)}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.calls ? `${Math.round((r.cached / r.calls) * 100)}%` : '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtNum(r.errors)}</td>
                    <td className="py-1.5 text-right tabular-nums text-fg-subtle">{fmtNum(r.est_credits, 1)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {fmtNum(r.actual_credits, 1)}
                      {Math.abs(diff) > 0.01 && (
                        <span className="text-[11px] text-[var(--color-tag-orange-100)] ml-1">{diff > 0 ? `+${fmtNum(diff, 1)}` : fmtNum(diff, 1)}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function ProjectCell({ p }: { p: RelProject }) {
  return (
    <div className="min-w-0">
      <div className="font-medium">
        {p.name} <span className="text-fg-muted font-normal">#{p.id}</span>
      </div>
      <div className="text-[11px] text-fg-muted truncate">
        {[p.website_domain, p.twitter_handle ? `@${p.twitter_handle}` : null, (p.chains ?? []).join('/') || null].filter(Boolean).join(' · ') || '—'}
      </div>
    </div>
  )
}

function ConflictQueue() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['relations', 'possible_duplicate'],
    queryFn: () => getJson<{ data: Relation[]; counts: Record<string, number> }>('projects/relations?status=possible_duplicate'),
  })
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'same' | 'different' }) =>
      sendJson(`projects/relations/${id}/decide`, 'POST', { decision }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['relations'] })
      qc.invalidateQueries({ queryKey: ['system-overview'] })
    },
  })
  const rows = data?.data ?? []
  const c = data?.counts ?? {}
  return (
    <Section
      title="身份冲突队列"
      desc="Surf ID 相同、同链合约相同、或官网与 X 账号同时相同，会自动合并；只有官网或只有 X 账号相同的，放在这里等你判断。"
      right={<span className="text-xs text-fg-muted shrink-0">已自动/人工合并 {c.confirmed_same ?? 0} · 确认不同 {c.confirmed_different ?? 0}</span>}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle">没有待判断的疑似重复项目。</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[1fr_1fr_auto] gap-4 items-center border-t border-border-base py-2.5 text-sm">
              <ProjectCell p={r.project_a} />
              <div className="min-w-0">
                <ProjectCell p={r.project_b} />
                <div className="text-[11px] text-fg-subtle mt-0.5">依据：{r.reason ?? '—'}</div>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, decision: 'same' })}
                  className="rounded-md bg-fg-base text-background px-3 py-1 text-xs font-semibold disabled:opacity-50"
                >
                  是同一项目，合并
                </button>
                <button
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, decision: 'different' })}
                  className="rounded-md border border-border-strong px-3 py-1 text-xs font-semibold hover:bg-bg-subtle-hover disabled:opacity-50"
                >
                  不同项目
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {decide.isError && <p className="text-xs text-destructive mt-2">{(decide.error as Error).message}</p>}
    </Section>
  )
}

interface AmbiguousEvent {
  id: number
  event_type: string
  title?: string | null
  candidate_name?: string | null
  event_at?: string | null
  url?: string | null
  candidates: RelProject[]
}

function AmbiguityQueue() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['ambiguous-events'],
    queryFn: () => getJson<{ data: AmbiguousEvent[] }>('projects/ambiguous-events'),
  })
  const link = useMutation({
    mutationFn: ({ id, projectId }: { id: number; projectId: number | null }) => sendJson(`projects/events/${id}/link`, 'POST', { projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ambiguous-events'] })
      qc.invalidateQueries({ queryKey: ['radar'] })
    },
  })
  const rows = data?.data ?? []
  return (
    <Section title="名称歧义队列" desc="事件里只识别出项目名，而项目池中有多个同名项目、无法自动判断时，不会默认关联，放在这里由你选择。">
      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle">没有待选择的事件。</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((e) => (
            <li key={e.id} className="border-t border-border-base py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <a href={e.url ?? undefined} target="_blank" rel="noreferrer" className="font-medium hover:underline underline-offset-2">
                  {e.title ?? e.candidate_name}
                </a>
                <span className="text-xs text-fg-muted shrink-0">{fmtTime(e.event_at)}</span>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {e.candidates.map((p) => (
                  <button
                    key={p.id}
                    disabled={link.isPending}
                    onClick={() => link.mutate({ id: e.id, projectId: p.id })}
                    className="rounded-md border border-border-strong px-2.5 py-1 text-xs hover:bg-bg-subtle-hover disabled:opacity-50 text-left"
                  >
                    关联到 {p.name} #{p.id}
                    <span className="text-fg-muted ml-1">
                      {[p.website_domain, p.twitter_handle ? `@${p.twitter_handle}` : null].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                ))}
                <button
                  disabled={link.isPending}
                  onClick={() => link.mutate({ id: e.id, projectId: null })}
                  className="rounded-md px-2.5 py-1 text-xs text-fg-subtle hover:bg-bg-subtle-hover disabled:opacity-50"
                >
                  都不是
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {link.isError && <p className="text-xs text-destructive mt-2">{(link.error as Error).message}</p>}
    </Section>
  )
}

function UsageLog() {
  const { data } = useQuery({
    queryKey: ['system-usage'],
    queryFn: () => getJson<{ data: UsageRow[] }>('system/usage?limit=30'),
  })
  const rows = data?.data ?? []
  return (
    <Section title="最近调用" desc="每次外部调用都会记账，原始响应另存一份，方便以后重新计算。">
      {rows.length === 0 ? (
        <p className="text-sm text-fg-subtle">暂无调用记录。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="font-normal py-1.5">时间</th>
                <th className="font-normal py-1.5">数据源</th>
                <th className="font-normal py-1.5">接口</th>
                <th className="font-normal py-1.5">触发</th>
                <th className="font-normal py-1.5">结果</th>
                <th className="font-normal py-1.5 text-right">预估 / 实际</th>
                <th className="font-normal py-1.5 text-right">耗时</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = USAGE_STATUS[r.status] ?? { label: r.status, cls: '' }
                return (
                  <tr key={r.id} className="border-t border-border-base align-top">
                    <td className="py-1.5 text-fg-subtle whitespace-nowrap">{fmtTime(r.created_at)}</td>
                    <td className="py-1.5">{r.provider}</td>
                    <td className="py-1.5 font-mono text-xs">{r.endpoint}</td>
                    <td className="py-1.5 text-fg-subtle">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                    <td className={`py-1.5 ${st.cls}`} title={r.error ?? ''}>
                      {st.label}
                      {r.error && <div className="text-[11px] text-fg-muted truncate max-w-[260px]">{r.error}</div>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      <span className="text-fg-muted">{r.estimated_credits != null ? fmtNum(r.estimated_credits, 1) : '—'}</span>
                      {' / '}
                      {fmtNum(r.credits, 1)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-fg-subtle">{r.duration_ms != null ? `${fmtNum(r.duration_ms)} ms` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

export default function SystemPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['system-overview'],
    queryFn: () => getJson<Overview>('system/overview'),
    retry: 1,
  })

  return (
    <div className="p-8 flex flex-col gap-5 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-bold">数据与点数</h1>
        <p className="text-sm text-fg-subtle mt-1">
          链能力、数据源、预算和自检。评分规则版本 {data?.settings?.score_version ?? '—'}
          {data?.settings?.robinhood_review_gate?.enabled ? ' · Robinhood Chain 复核门槛：开启' : ''}
        </p>
      </div>
      {isLoading && <p className="text-sm text-fg-subtle">加载中…</p>}
      {error && (
        <div className="border border-border-base rounded-lg p-5 text-sm">
          <div className="font-semibold">数据库暂不可用</div>
          <div className="text-fg-subtle mt-1 break-all">{(error as Error).message}</div>
        </div>
      )}
      {data && (
        <>
          <BudgetPanel o={data} />
          <ChainMatrix chains={data.chains} />
          <ProvidersTable providers={data.providers} />
          <EndpointStats rows={data.budget.byEndpoint ?? []} />
          <ConflictQueue />
          <AmbiguityQueue />
          <IdentityBackfill />
          <SelftestPanel last={data.last_selftest} />
          {data.settings.surf_budget && <BudgetSettings setting={data.settings.surf_budget} />}
          {data.settings.pipeline_config && <PipelineSettings setting={data.settings.pipeline_config} />}
          <UsageLog />
        </>
      )}
    </div>
  )
}
