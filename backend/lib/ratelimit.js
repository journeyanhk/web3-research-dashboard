// 进程内的简单限速：每个桶保证最小请求间隔。
const last = new Map()
const queues = new Map()

function waitTurn(bucket, minIntervalMs) {
  const prev = queues.get(bucket) || Promise.resolve()
  const next = prev.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, (last.get(bucket) || 0) + minIntervalMs - now)
    if (wait) await new Promise((r) => setTimeout(r, wait))
    last.set(bucket, Date.now())
  })
  queues.set(bucket, next.catch(() => {}))
  return next
}

module.exports = { waitTurn }
