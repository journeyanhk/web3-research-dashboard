import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getJson, sendJson, fmtNum, fmtTime } from '@/lib/fetcher'
import { STAGE_LABEL } from '@/lib/labels'

interface Alert {
  id: number
  project_id?: number | null
  category: string
  alert_type: string
  severity: string
  title?: string | null
  detail?: Record<string, unknown> | null
  status: string
  created_at: string
  resolved_at?: string | null
  project_name?: string | null
  project_stage?: string | null
}
interface AlertsResponse {
  data: Alert[]
  counts: { open: number; signal: number; critical: number; total: number }
  types: Record<string, { label: string; severity: string }>
}

const STATUS_OPTIONS = [
  ['open', '未处理'],
  ['resolved', '已处理'],
  ['all', '全部'],
] as const

const CAT_LABEL: Record<string, string> = { signal: '信号', data: '数据', budget: '预算', identity: '身份', task: '任务' }

function typeLabel(a: Alert, types: AlertsResponse['types']) {
  return types[a.alert_type]?.label ?? a.alert_type
}

const dot = (severity: string) =>
  severity === 'critical' ? 'bg-destructive'
    : severity === 'warn' ? 'bg-[var(--color-tag-orange-100)]'
      : 'bg-[var(--color-tag-blue-100)]'

export default function AlertsPage() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<string>('open')
  const [category, setCategory] = useState('')
  const { data, isLoading, error } = useQuery({
    queryKey: ['alerts', status, category],
    queryFn: () => getJson<AlertsResponse>(`alerts?status=${status}${category ? `&category=${category}` : ''}`),
  })
  const resolve = useMutation({
    mutationFn: (id: number) => sendJson(`alerts/${id}/resolve`, 'POST', {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['radar'] }) },
  })
  const resolveAll = useMutation({
    mutationFn: () => sendJson('alerts/resolve-all', 'POST', category ? { category } : {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alerts'] }); qc.invalidateQueries({ queryKey: ['radar'] }) },
  })
  const scan = useMutation({
    mutationFn: () => sendJson<{ scanned: number; created: number }>('alerts/scan', 'POST'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })

  return (
    <div className="p-6 max-w-[1100px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">提醒中心</h1>
          <p className="text-sm text-fg-subtle mt-1">
            TGE、上币、新融资、进入初筛、即将归档、重新激活。同一事件只提醒一次，处理过的可以在「已处理」里查。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => scan.mutate()} disabled={scan.isPending}
            className="text-xs rounded-md border border-border-base px-3 py-1.5 hover:bg-bg-subtle-hover disabled:opacity-50">
            {scan.isPending ? '扫描中…' : '立即扫描事件'}
          </button>
          <button onClick={() => resolveAll.mutate()} disabled={resolveAll.isPending || !data?.counts.open}
            className="text-xs rounded-md border border-border-base px-3 py-1.5 hover:bg-bg-subtle-hover disabled:opacity-50">
            全部标记已处理
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-5">
        <div className="flex items-center gap-1">
          {STATUS_OPTIONS.map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
              className={`text-xs rounded-md px-2.5 py-1 border ${status === k ? 'border-border-strong bg-bg-subtle font-semibold' : 'border-border-base text-fg-subtle hover:bg-bg-subtle-hover'}`}>
              {label}
            </button>
          ))}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)}
          className="text-xs rounded-md border border-border-base bg-transparent px-2 py-1">
          <option value="">全部类别</option>
          {Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {data && (
          <span className="text-xs text-fg-muted">
            未处理 {fmtNum(data.counts.open)} 条（信号 {fmtNum(data.counts.signal)} 条{data.counts.critical ? `，严重 ${data.counts.critical} 条` : ''}）
            {scan.data ? ` · 本次扫描新增 ${scan.data.created} 条` : ''}
          </span>
        )}
      </div>

      {isLoading && <p className="text-sm text-fg-subtle mt-6">加载中…</p>}
      {error && <p className="text-sm text-destructive mt-6">加载失败：{(error as Error).message}</p>}

      {data && (
        <div className="mt-5 border border-border-base rounded-lg divide-y divide-border-base">
          {data.data.length === 0 ? (
            <p className="text-sm text-fg-subtle p-5">没有{status === 'open' ? '未处理的' : ''}提醒。</p>
          ) : data.data.map((a) => (
            <div key={a.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dot(a.severity)}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  {a.project_id ? (
                    <a href={`#/projects/${a.project_id}`} className="hover:underline">{a.title ?? typeLabel(a, data.types)}</a>
                  ) : (a.title ?? typeLabel(a, data.types))}
                </div>
                <div className="text-[11px] text-fg-muted mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>{CAT_LABEL[a.category] ?? a.category} · {typeLabel(a, data.types)}</span>
                  {a.project_stage && <span>当前阶段：{STAGE_LABEL[a.project_stage] ?? a.project_stage}</span>}
                  <span>{fmtTime(a.created_at)}</span>
                  {a.resolved_at && <span>处理于 {fmtTime(a.resolved_at)}</span>}
                </div>
              </div>
              {a.status === 'open' ? (
                <button onClick={() => resolve.mutate(a.id)} disabled={resolve.isPending}
                  className="text-xs text-fg-subtle hover:text-fg-base shrink-0 disabled:opacity-50">标记已处理</button>
              ) : (
                <span className="text-xs text-fg-muted shrink-0">已处理</span>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-fg-muted mt-4">
        提醒只在本站显示，不发邮件 / Telegram。金额与交易所信息来自 Surf 事件，仅作线索。
      </p>
    </div>
  )
}
