// 指标写入：只追加，记录来源、主源/备用源、置信度
const db = require('./db')

async function recordMetric(m) {
  const r = await db.one(
    `INSERT INTO wr_metrics (project_id, chain, subject, metric_name, value, value_json, unit, source, primary_source,
       fallback_used, fallback_reason, observed_at, confidence, raw_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [m.projectId || null, m.chain || null, m.subject || null, m.name, m.value ?? null,
      m.valueJson ? JSON.stringify(m.valueJson) : null, m.unit || null, m.source, m.primarySource || m.source,
      !!m.fallbackUsed, m.fallbackReason || null, m.observedAt || new Date().toISOString(), m.confidence ?? null, m.rawId || null],
  )
  return r.id
}

module.exports = { recordMetric }
