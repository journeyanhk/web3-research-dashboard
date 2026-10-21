// 统一调用管道：缓存 → 预算检查 → 限速 → 带退避重试的请求 → 原始存档 → 记账 → 更新数据源状态
const crypto = require('node:crypto')
const db = require('../db')
const registry = require('../registry')
const budget = require('../budget')
const { withRetry } = require('../http')
const { waitTurn } = require('../ratelimit')
const surf = require('./surf')
const helius = require('./helius')
const rest = require('./rest')

const ADAPTERS = { surf, helius, ...rest }

class BudgetBlockedError extends Error {
  constructor(reason) { super(reason); this.blocked = true }
}

function stable(obj) {
  if (Array.isArray(obj)) return `[${obj.map(stable).join(',')}]`
  if (obj && typeof obj === 'object') return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`
  return JSON.stringify(obj)
}
const hashParams = (provider, endpoint, params) =>
  crypto.createHash('sha1').update(`${provider}|${endpoint}|${stable(params || {})}`).digest('hex')

async function logUsage(u) {
  const r = await db.one(
    `INSERT INTO wr_api_usage (provider, endpoint, params, trigger, task, priority, project_id, status, http_status,
       actual_credits, estimated_credits, duration_ms, attempts, rate_limited, error, raw_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [u.provider, u.endpoint, JSON.stringify(u.params || {}), u.trigger, u.task || null, u.priority || null,
      u.projectId || null, u.status, u.httpStatus || null, u.credits || 0, u.estCost ?? null, u.durationMs || null,
      u.attempts || 1, u.rateLimited || 0, u.error ? String(u.error).slice(0, 500) : null, u.rawId || null],
  )
  return r?.id
}

async function saveRaw({ provider, endpoint, hash, params, status, httpStatus, body, error }) {
  const r = await db.one(
    `INSERT INTO wr_raw_responses (provider, endpoint, params_hash, params, status, http_status, body, error, response_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [provider, endpoint, hash, JSON.stringify(params || {}), status, httpStatus || null,
      body == null ? null : JSON.stringify(body), error ? String(error).slice(0, 1000) : null,
      body?.$schema || body?.schemaVersion || null],
  )
  return r?.id
}

/**
 * call({ provider, endpoint, params, method, trigger, task, priority, projectId, cacheTtlSec, estCost })
 * 返回 { body, rawId, cached, credits, provider }
 */
async function call(opts) {
  const {
    provider, endpoint, params = {}, method = 'GET', trigger = 'auto', task, priority = 'normal',
    projectId, cacheTtlSec = 0,
  } = opts
  const adapter = ADAPTERS[provider]
  if (!adapter) throw new Error(`未知数据源：${provider}`)
  const prov = await registry.get('provider', provider)
  if (prov && prov.enabled === false) throw new BudgetBlockedError(`${provider} 已停用`)
  const hash = hashParams(provider, endpoint, params)
  const base = { provider, endpoint, params, trigger, task, priority, projectId }

  // 1. 缓存：有效期内的成功响应直接复用，不花点数
  if (cacheTtlSec > 0) {
    const hit = await db.one(
      `SELECT id, body FROM wr_raw_responses WHERE provider=$1 AND endpoint=$2 AND params_hash=$3 AND status='ok'
         AND fetched_at > now() - ($4 || ' seconds')::interval ORDER BY fetched_at DESC LIMIT 1`,
      [provider, endpoint, hash, String(cacheTtlSec)],
    )
    if (hit) {
      await logUsage({ ...base, status: 'cached', credits: 0, rawId: hit.id, durationMs: 0 })
      return { body: hit.body, rawId: hit.id, cached: true, credits: 0, provider }
    }
  }

  // 2. 预算检查（预估成本：已知接口查成本表，未知接口用保守值）
  const estCost = opts.estCost ?? adapter.estimate({ endpoint, params, costTable: prov?.cost_table })
  const verdict = await budget.check({ provider, trigger, priority, projectId, estCost })
  if (!verdict.allowed) {
    await logUsage({ ...base, status: 'blocked', credits: 0, estCost, error: verdict.reason })
    throw new BudgetBlockedError(verdict.reason)
  }

  // 3. 限速 + 4. 请求（退避重试）
  const started = Date.now()
  const bucket = adapter.bucket ? adapter.bucket(endpoint) : provider
  try {
    const { result, attempts, rateLimited } = await withRetry(async () => {
      await waitTurn(bucket, adapter.minIntervalMs(endpoint))
      return adapter.execute({ endpoint, params, method, costTable: prov?.cost_table })
    })
    const rawId = await saveRaw({ provider, endpoint, hash, params, status: 'ok', httpStatus: result.status, body: result.body })
    await logUsage({ ...base, status: 'ok', httpStatus: result.status, credits: result.credits, estCost, durationMs: Date.now() - started, attempts, rateLimited, rawId })
    if (projectId && result.credits > 0) {
      await db.query('UPDATE wr_projects SET credits_spent = credits_spent + $1, updated_at = now() WHERE id = $2', [result.credits, projectId])
    }
    await registry.patch('provider', provider, { last_success_at: new Date().toISOString() })
    return { body: result.body, rawId, cached: false, credits: result.credits, provider }
  } catch (err) {
    const rawId = await saveRaw({ provider, endpoint, hash, params, status: 'error', httpStatus: err.status, body: err.body, error: err.message })
    await logUsage({ ...base, status: 'error', httpStatus: err.status, credits: 0, estCost, durationMs: Date.now() - started,
      attempts: err.attempts, rateLimited: err.rateLimited, error: err.message, rawId })
    await registry.patch('provider', provider, { last_error_at: new Date().toISOString(), last_error: String(err.message).slice(0, 300) })
    err.rawId = rawId
    throw err
  }
}

/**
 * 主源失败或返回空时切换到备用源，并明确标记 fallback_used。
 * steps: [{ provider, endpoint, params, parse(body) => value|null }]
 * 返回 { value, source, primarySource, fallbackUsed, fallbackReason, rawId, attempts:[...] }
 */
async function callWithFallback(steps, common = {}) {
  const attemptsLog = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    try {
      const res = await call({ ...common, ...s })
      const value = s.parse ? s.parse(res.body) : res.body
      if (value == null) {
        attemptsLog.push({ provider: s.provider, ok: false, reason: '返回为空', rawId: res.rawId })
        continue
      }
      attemptsLog.push({ provider: s.provider, ok: true, rawId: res.rawId })
      return {
        value, source: s.provider, primarySource: steps[0].provider, fallbackUsed: i > 0,
        fallbackReason: i > 0 ? attemptsLog.filter((a) => !a.ok).map((a) => `${a.provider}: ${a.reason}`).join('; ') : null,
        rawId: res.rawId, attempts: attemptsLog,
      }
    } catch (e) {
      attemptsLog.push({ provider: s.provider, ok: false, reason: e.message, rawId: e.rawId })
    }
  }
  const err = new Error(`所有数据源均失败：${attemptsLog.map((a) => `${a.provider}: ${a.reason}`).join('; ')}`)
  err.attempts = attemptsLog
  throw err
}

module.exports = { call, callWithFallback, BudgetBlockedError, hashParams }
