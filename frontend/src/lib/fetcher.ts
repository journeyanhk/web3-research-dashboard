import { api } from './api'
import { getToken, clearToken, AUTH_EVENT } from './auth'

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra || {}) }
  const t = getToken()
  if (t) h.authorization = `Bearer ${t}`
  return h
}

async function handle<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({}))
  if (r.status === 401 && (body as { auth_required?: boolean })?.auth_required) {
    clearToken()
    window.dispatchEvent(new Event(AUTH_EVENT))
  }
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败（${r.status}）`)
  return body as T
}

export async function getJson<T>(path: string): Promise<T> {
  return handle<T>(await fetch(api(path), { headers: headers() }))
}

export async function sendJson<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', data?: unknown): Promise<T> {
  return handle<T>(await fetch(api(path), {
    method,
    headers: headers({ 'content-type': 'application/json' }),
    body: data === undefined ? undefined : JSON.stringify(data),
  }))
}

export const fmtNum = (n: number | null | undefined, d = 0) =>
  n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 })

export const fmtTime = (s?: string | null) => {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// 「3 天前」式的相对时间
export const fmtAgo = (s?: string | null) => {
  if (!s) return '—'
  const t = new Date(s).getTime()
  if (Number.isNaN(t)) return '—'
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 60) return `${Math.max(m, 1)} 分钟前`
  if (m < 1440) return `${Math.round(m / 60)} 小时前`
  return `${Math.round(m / 1440)} 天前`
}
