// 站内告警写入（同一 dedupe_key 只保留一条未处理告警）
const db = require('./db')

async function raiseAlert({ category, type, severity = 'info', title, detail, projectId = null, dedupeKey = null }) {
  if (dedupeKey) {
    const exist = await db.one("SELECT id FROM wr_alerts WHERE dedupe_key = $1 AND status = 'open'", [dedupeKey])
    if (exist) return exist.id
  }
  const r = await db.one(
    `INSERT INTO wr_alerts (project_id, category, alert_type, severity, title, detail, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [projectId, category, type, severity, title, JSON.stringify(detail || {}), dedupeKey],
  )
  return r.id
}

module.exports = { raiseAlert }
