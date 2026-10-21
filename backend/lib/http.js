// 带指数退避 + 随机抖动的请求重试。只对 429 / 503 / 临时 5xx / 网络错误重试。
const RETRYABLE = new Set([429, 500, 502, 503, 504])

class HttpError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function backoffMs(attempt, base = 800, max = 15000) {
  const exp = Math.min(max, base * 2 ** attempt)
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}

/**
 * fn(attempt) 执行一次请求；抛出带 status 的错误时按规则重试。
 * 返回 { result, attempts, rateLimited }
 */
async function withRetry(fn, { maxRetries = 3 } = {}) {
  let rateLimited = 0
  let lastErr
  let made = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    made = attempt + 1
    try {
      const result = await fn(attempt)
      return { result, attempts: attempt + 1, rateLimited }
    } catch (err) {
      lastErr = err
      const status = err.status
      if (status === 429) rateLimited++
      const retryable = status == null ? err.network === true : RETRYABLE.has(status)
      if (!retryable || attempt === maxRetries) break
      await sleep(backoffMs(attempt))
    }
  }
  lastErr.attempts = made
  lastErr.rateLimited = rateLimited
  throw lastErr
}

async function fetchJson(url, init = {}, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    const err = new HttpError(e.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : `网络错误：${e.message}`)
    err.network = true
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { _text: text.slice(0, 500) } }
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, body)
  return { status: res.status, body }
}

module.exports = { withRetry, fetchJson, HttpError, sleep }
