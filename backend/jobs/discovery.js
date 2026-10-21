// 定时任务入口（backend/cron.json）：每日全局发现采集
const { runDiscovery } = require('../lib/collect/discovery')

async function handler() {
  const r = await runDiscovery({ trigger: 'auto' })
  if (r.skipped) { console.log('[cron] discovery skipped:', r.reason); return }
  console.log('[cron] discovery', JSON.stringify({ status: r.status, runId: r.runId, credits: r.stats?.surf_credits }))
  if (r.status === 'error') throw new Error((r.stats?.errors || []).join('; '))
}

module.exports = { handler }
