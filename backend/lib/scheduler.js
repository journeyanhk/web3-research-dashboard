// 内置每日调度（不依赖 cron.json）
//
// 原因：Surf 发布时只有开启 enable_cron 才保留 cron.json，否则会被删除；生产实例也可能闲置休眠。
// 做法：
//   1. 进程内每 10 分钟检查一次：北京时间 09:17（01:17 UTC）之后、今天还没有成功的自动采集 → 触发
//   2. 进程启动 90 秒后检查一次（休眠唤醒 / 重新发布后补跑）
//   3. 有人打开雷达页时也检查一次（实例休眠时靠访问唤醒补跑）
// 去重：全局租约锁 + 「今天已成功自动采集则跳过」+ 每天自动尝试最多 3 次（失败不会无限重试扣点）。
// 关闭：环境变量 WR_SCHEDULER=off
const db = require('./db')

const RUN_AFTER_UTC = { hour: 1, minute: 17 }
const MAX_AUTO_ATTEMPTS_PER_DAY = 3
let started = false
let checking = false
let lastCheck = { at: null, result: null }

function dueToday(now = new Date()) {
  const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_AFTER_UTC.hour, RUN_AFTER_UTC.minute))
  return now >= due
}

async function ensureDailyRun(reason = 'timer') {
  if (process.env.WR_SCHEDULER === 'off') return { skipped: true, reason: '调度已关闭（WR_SCHEDULER=off）' }
  if (checking) return { skipped: true, reason: '检查进行中' }
  if (!dueToday()) return { skipped: true, reason: '未到今天的采集时间（北京时间 09:17）' }
  checking = true
  try {
    // 进程重启 / 实例休眠会打断正在运行的采集：超过 30 分钟仍是 running 的记录标为中断（计入当天尝试次数）
    await db.query(
      `UPDATE wr_job_runs SET status = 'abandoned', finished_at = now(), error = COALESCE(error, '进程中断（重启或休眠）')
       WHERE status = 'running' AND started_at < now() - interval '30 minutes'`)
    const today = await db.one(
      `SELECT count(*) FILTER (WHERE status IN ('ok','partial'))::int AS done,
              count(*)::int AS attempts
       FROM wr_job_runs WHERE job = 'discovery' AND trigger = 'auto' AND started_at >= date_trunc('day', now())`)
    if (today.done > 0) return { skipped: true, reason: '今天已完成自动采集' }
    if (today.attempts >= MAX_AUTO_ATTEMPTS_PER_DAY) return { skipped: true, reason: `今天自动采集已尝试 ${today.attempts} 次均失败，停止重试` }
    const { runDiscovery } = require('./collect/discovery')
    console.log(`[scheduler] 触发每日自动采集（${reason}）`)
    // 后台执行，不阻塞调用方（例如页面请求）
    runDiscovery({ trigger: 'auto' })
      .then((r) => console.log('[scheduler] 完成', JSON.stringify({ status: r.status, skipped: r.skipped, reason: r.reason, credits: r.stats?.surf_credits })))
      .catch((e) => console.error('[scheduler] 失败', e.message))
    return { triggered: true, reason }
  } finally {
    checking = false
  }
}

function start() {
  if (started || process.env.WR_SCHEDULER === 'off') return
  started = true
  const tick = (reason) => ensureDailyRun(reason)
    .then((r) => { lastCheck = { at: new Date().toISOString(), result: r } })
    .catch((e) => { lastCheck = { at: new Date().toISOString(), result: { error: e.message } } })
  setTimeout(() => tick('startup'), 90 * 1000).unref?.()
  setInterval(() => tick('timer'), 10 * 60 * 1000).unref?.()
  console.log('[scheduler] 内置每日调度已启动（北京时间 09:17 之后，每 10 分钟检查一次）')
}

const status = () => ({ started, lastCheck, run_after_utc: '01:17', max_attempts_per_day: MAX_AUTO_ATTEMPTS_PER_DAY })

module.exports = { start, ensureDailyRun, dueToday, status }
