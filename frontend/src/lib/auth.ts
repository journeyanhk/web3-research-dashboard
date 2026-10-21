// 登录令牌：存在浏览器本地（预览在 iframe 中，跨站 Cookie 可能被拦截，所以不用 Cookie）
const KEY = 'wr_token'
export const AUTH_EVENT = 'wr-auth-required'

export function getToken(): string | null {
  try { return window.localStorage.getItem(KEY) } catch { return null }
}
export function setToken(t: string) {
  try { window.localStorage.setItem(KEY, t) } catch { /* 无痕模式等情况下忽略 */ }
}
export function clearToken() {
  try { window.localStorage.removeItem(KEY) } catch { /* ignore */ }
}
