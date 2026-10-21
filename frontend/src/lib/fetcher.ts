import { api } from './api'

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(api(path))
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败（${r.status}）`)
  return body as T
}

export async function sendJson<T>(path: string, method: 'POST' | 'PUT', data?: unknown): Promise<T> {
  const r = await fetch(api(path), {
    method,
    headers: { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败（${r.status}）`)
  return body as T
}

export const fmtNum = (n: number | null | undefined, d = 0) =>
  n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 })

export const fmtTime = (s?: string | null) => {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
