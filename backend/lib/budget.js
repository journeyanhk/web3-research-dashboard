// 三道点数限额（Surf）+ Helius 额度保护线
const db = require('./db')
const registry = require('./registry')
const { raiseAlert: raiseAlertReal } = require('./alerts')

async function sumCredits(provider, where = '', params = []) {
  const r = await db.one(
    `SELECT COALESCE(SUM(actual_credits),0)::float AS s FROM wr_api_usage
     WHERE provider = $1 AND status IN ('ok','error') ${where}`,
    [provider, ...params],
  )
  return Number(r?.s || 0)
}

const monthWhere = "AND created_at >= date_trunc('month', now())"
const todayWhere = "AND created_at >= date_trunc('day', now())"

async function surfStatus() {
  const cfg = (await registry.getSetting('surf_budget')) || registry.DEFAULT_SETTINGS.surf_budget
  const monthUsed = await sumCredits('surf', monthWhere)
  const todayAuto = await sumCredits('surf', `${todayWhere} AND trigger = 'auto'`)
  const todayAll = await sumCredits('surf', todayWhere)
  const dailyAutoCap = +((cfg.monthly / 30) * cfg.auto_ratio).toFixed(1)
  return { monthly: cfg.monthly, monthUsed, todayAuto, todayAll, dailyAutoCap, autoRatio: cfg.auto_ratio, stageTotalCaps: cfg.stage_total_caps }
}

const STAGE_ORDER = ['discovery', 'screening', 'deep_research', 'tge_watch']
// 单项目「全程累计」上限：项目从发现起累计消耗的点数，不得超过其当前阶段对应的累计值
// （例：discovery 3 → screening 8 → deep_research 30 → tge_watch 45，升级后不会额外叠加）
function projectCap(stageTotalCaps, level) {
  return Number(stageTotalCaps?.[level] ?? stageTotalCaps?.discovery ?? 3)
}

async function heliusStatus() {
  const prov = await registry.get('provider', 'helius')
  const th = (await registry.getSetting('helius_budget')) || registry.DEFAULT_SETTINGS.helius_budget
  const quota = Number(prov?.monthly_quota || 1000000)
  const used = await sumCredits('helius', monthWhere)
  const ratio = quota ? used / quota : 0
  let level = 'normal'
  if (ratio >= th.stop) level = 'stopped'
  else if (ratio >= th.manual_only) level = 'manual_only'
  else if (ratio >= th.pause_nonessential) level = 'paused_nonessential'
  else if (ratio >= th.warn) level = 'warn'
  return { quota, used, ratio, level, thresholds: th }
}

/**
 * 调用前检查。返回 { allowed, reason }
 * ctx: { provider, trigger, priority, projectId, estCost }
 */
async function check({ provider, trigger, priority = 'normal', projectId, estCost = 1 }) {
  // 自检触发的拦截不写告警，避免误报
  const raiseAlert = trigger === 'selftest' ? async () => null : raiseAlertReal
  if (provider === 'surf') {
    const s = await surfStatus()
    if (s.monthUsed + estCost > s.monthly) {
      await raiseAlert({ category: 'budget', type: 'surf_monthly_exhausted', severity: 'critical',
        title: 'Surf 月度数据预算已用完', detail: s, dedupeKey: `surf_month_${monthKey()}` })
      return { allowed: false, reason: `本月 Surf 预算已用 ${s.monthUsed}/${s.monthly} 点` }
    }
    if (trigger === 'auto' && s.todayAuto + estCost > s.dailyAutoCap) {
      await raiseAlert({ category: 'budget', type: 'surf_daily_auto_cap', severity: 'warn',
        title: '今日自动任务点数已达上限，自动采集暂停到明天', detail: s, dedupeKey: `surf_day_${dayKey()}` })
      return { allowed: false, reason: `今日自动任务已用 ${s.todayAuto}/${s.dailyAutoCap} 点` }
    }
    if (trigger === 'auto' && projectId) {
      const p = await db.one('SELECT credits_spent, coverage_level, name FROM wr_projects WHERE id = $1', [projectId])
      if (p) {
        const capVal = projectCap(s.stageTotalCaps, p.coverage_level)
        if (Number(p.credits_spent) + estCost > capVal) {
          await raiseAlert({ category: 'budget', type: 'project_budget_exceeded', severity: 'warn', projectId,
            title: `${p.name} 已达到当前阶段的点数上限`, detail: { spent: Number(p.credits_spent), cap: capVal, level: p.coverage_level },
            dedupeKey: `proj_cap_${projectId}_${p.coverage_level}` })
          return { allowed: false, scope: 'project', reason: `项目已用 ${p.credits_spent}/${capVal} 点（${p.coverage_level}）` }
        }
      }
    }
    if (s.monthUsed / s.monthly >= 0.8) {
      await raiseAlert({ category: 'budget', type: 'surf_monthly_80', severity: 'warn',
        title: 'Surf 月度数据预算已用 80%', detail: s, dedupeKey: `surf_month80_${monthKey()}` })
    }
    return { allowed: true }
  }
  if (provider === 'helius') {
    const h = await heliusStatus()
    if (h.level === 'stopped') return { allowed: false, reason: 'Helius 本月额度已用完' }
    if (h.level === 'manual_only' && trigger === 'auto') return { allowed: false, reason: 'Helius 额度 ≥95%，只允许手动查询' }
    if (h.level === 'paused_nonessential' && trigger === 'auto' && priority !== 'essential') {
      return { allowed: false, reason: 'Helius 额度 ≥85%，已暂停非必要任务' }
    }
    if (h.level !== 'normal') {
      await raiseAlert({ category: 'budget', type: `helius_${h.level}`, severity: h.level === 'warn' ? 'warn' : 'critical',
        title: `Helius 额度已用 ${(h.ratio * 100).toFixed(0)}%`, detail: h, dedupeKey: `helius_${h.level}_${monthKey()}` })
    }
    return { allowed: true }
  }
  return { allowed: true }
}

function monthKey() { const d = new Date(); return `${d.getUTCFullYear()}${d.getUTCMonth() + 1}` }
function dayKey() { return new Date().toISOString().slice(0, 10) }

module.exports = { check, surfStatus, heliusStatus, projectCap, STAGE_ORDER }
