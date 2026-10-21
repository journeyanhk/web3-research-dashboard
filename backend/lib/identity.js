// 项目身份确认、去重与合并
//
// 高置信度（自动合并）：Surf 项目 ID 相同；或同一条链上合约地址相同；或官网域名 + 官方 X 账号同时相同
// 低置信度（只进冲突队列，不合并）：只有域名相同、只有 X 账号相同（同一官网下多个产品、改名等情况）
const db = require('./db')
const { raiseAlert } = require('./alerts')

const EVM_CHAINS = new Set(['ethereum', 'bsc', 'base', 'arbitrum', 'robinhood', 'polygon', 'optimism', 'avalanche'])
const STRONG_TYPES = new Set(['surf_id', 'contract'])

// 引用 project_id 的表：合并时统一迁移。后续里程碑新增的表（事件、评分、快照…）需要加到这里。
const PROJECT_REF_TABLES = ['wr_metrics', 'wr_alerts', 'wr_api_usage']

const LEVEL_ORDER = ['discovery', 'screening', 'deep_research', 'tge_watch']

// Surf 返回的链名 → 本系统链 ID
const CHAIN_ALIASES = {
  ethereum: 'ethereum', eth: 'ethereum', 'ethereum mainnet': 'ethereum',
  bsc: 'bsc', 'binance smart chain': 'bsc', 'bnb chain': 'bsc', bnb: 'bsc', 'bnb smart chain': 'bsc',
  base: 'base',
  arbitrum: 'arbitrum', 'arbitrum one': 'arbitrum',
  solana: 'solana', sol: 'solana',
  robinhood: 'robinhood', 'robinhood chain': 'robinhood',
  arc: 'arc',
}
function normalizeChain(name) {
  if (!name) return null
  const k = String(name).trim().toLowerCase()
  return CHAIN_ALIASES[k] || k.replace(/\s+/g, '-')
}

function normalizeDomain(url) {
  if (!url) return null
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    return u.hostname.toLowerCase().replace(/^www\./, '') || null
  } catch { return null }
}

function normalizeTwitter(h) {
  if (!h) return null
  let s = String(h).trim()
  const m = /(?:twitter\.com|x\.com)\/([^/?#]+)/i.exec(s)
  if (m) s = m[1]
  s = s.replace(/^@/, '').toLowerCase()
  return s || null
}

function normalizeContract(chain, address) {
  const c = normalizeChain(chain)
  if (!c || !address) return null
  const addr = EVM_CHAINS.has(c) || /^0x[0-9a-fA-F]{40}$/.test(address) ? String(address).toLowerCase() : String(address)
  return `${c}:${addr}`
}

function buildIdentifiers(input) {
  const ids = []
  if (input.surfId) ids.push(['surf_id', String(input.surfId)])
  const d = normalizeDomain(input.website)
  if (d) ids.push(['domain', d])
  const t = normalizeTwitter(input.twitter)
  if (t) ids.push(['twitter', t])
  for (const c of input.contracts || []) {
    const v = normalizeContract(c.chain, c.address)
    if (v) ids.push(['contract', v])
  }
  return ids
}

// 根据标识命中情况，把候选项目分成强匹配 / 弱匹配
function classifyMatches(rows) {
  const per = new Map()
  for (const r of rows) {
    if (!per.has(r.project_id)) per.set(r.project_id, new Set())
    per.get(r.project_id).add(r.id_type)
  }
  const strong = []
  const weak = []
  for (const [pid, types] of per) {
    const reasons = []
    if (types.has('surf_id')) reasons.push('Surf 项目 ID 相同')
    if (types.has('contract')) reasons.push('合约地址相同')
    if (types.has('domain') && types.has('twitter')) reasons.push('官网域名与 X 账号同时相同')
    if (reasons.length) strong.push({ projectId: pid, reasons })
    else weak.push({ projectId: pid, reasons: [...types].map((t) => (t === 'domain' ? '官网域名相同' : 'X 账号相同')) })
  }
  return { strong, weak }
}

const pair = (a, b) => (a < b ? [a, b] : [b, a])

async function relationStatus(a, b) {
  const [x, y] = pair(a, b)
  const r = await db.one('SELECT status FROM wr_project_relations WHERE project_a = $1 AND project_b = $2', [x, y])
  return r?.status || null
}

// 记录疑似重复（已确认不同的不会再提示）
async function flagPossibleDuplicate(a, b, reasons, evidence) {
  const [x, y] = pair(a, b)
  const existing = await relationStatus(x, y)
  if (existing === 'confirmed_different' || existing === 'confirmed_same') return
  await db.query(
    `INSERT INTO wr_project_relations (project_a, project_b, status, reason, confidence, evidence)
     VALUES ($1,$2,'possible_duplicate',$3,'low',$4)
     ON CONFLICT (project_a, project_b) DO UPDATE SET reason = EXCLUDED.reason, evidence = EXCLUDED.evidence`,
    [x, y, reasons.join('、'), JSON.stringify(evidence || {})],
  )
  const names = await db.query('SELECT id, name FROM wr_projects WHERE id = ANY($1)', [[x, y]])
  const label = names.map((n) => `${n.name}(#${n.id})`).join(' 与 ')
  await raiseAlert({
    category: 'data', type: 'possible_duplicate', severity: 'info', projectId: x,
    title: `${label} 可能是同一项目：${reasons.join('、')}`, detail: { projects: [x, y], reasons },
    dedupeKey: `dup_${x}_${y}`,
  })
}

/**
 * 合并项目：source 并入 target，迁移身份标识、指标、告警、调用记录与点数消耗。
 * 同一事务内完成，失败整体回滚。
 */
async function mergeProjects(sourceId, targetId, { reason, confidence = 'high', by = 'auto', evidence } = {}) {
  if (sourceId === targetId) return targetId
  await db.tx(async (q) => {
    const [src] = await q('SELECT * FROM wr_projects WHERE id = $1 FOR UPDATE', [sourceId])
    const [tgt] = await q('SELECT * FROM wr_projects WHERE id = $1 FOR UPDATE', [targetId])
    if (!src || !tgt) throw new Error(`合并失败：项目 #${sourceId} 或 #${targetId} 不存在`)
    if (src.merged_into) throw new Error(`项目 #${sourceId} 已并入 #${src.merged_into}`)

    // 身份标识：目标已有的同值标识删掉，其余转移
    await q(
      `DELETE FROM wr_project_ids s USING wr_project_ids t
       WHERE s.project_id = $1 AND t.project_id = $2 AND s.id_type = t.id_type AND s.id_value = t.id_value`,
      [sourceId, targetId],
    )
    await q('UPDATE wr_project_ids SET project_id = $2 WHERE project_id = $1', [sourceId, targetId])

    for (const table of PROJECT_REF_TABLES) {
      await q(`UPDATE ${table} SET project_id = $2 WHERE project_id = $1`, [sourceId, targetId])
    }

    // 项目字段：目标为空的用源补齐；链取并集；首次发现时间取更早；覆盖层级取更高；点数合并
    const level = LEVEL_ORDER[Math.max(LEVEL_ORDER.indexOf(src.coverage_level), LEVEL_ORDER.indexOf(tgt.coverage_level), 0)]
    await q(
      `UPDATE wr_projects t SET
         surf_project_id = COALESCE(t.surf_project_id, s.surf_project_id),
         symbol = COALESCE(t.symbol, s.symbol),
         website_domain = COALESCE(t.website_domain, s.website_domain),
         twitter_handle = COALESCE(t.twitter_handle, s.twitter_handle),
         category = COALESCE(t.category, s.category),
         primary_chain = COALESCE(t.primary_chain, s.primary_chain),
         chains = (SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb)
                   FROM jsonb_array_elements_text(COALESCE(t.chains,'[]'::jsonb) || COALESCE(s.chains,'[]'::jsonb)) AS c),
         first_seen_at = LEAST(t.first_seen_at, s.first_seen_at),
         coverage_level = $3,
         credits_spent = t.credits_spent + s.credits_spent,
         updated_at = now()
       FROM wr_projects s WHERE t.id = $2 AND s.id = $1`,
      [sourceId, targetId, level],
    )
    await q(
      `UPDATE wr_projects SET merged_into = $2, stage = 'merged', credits_spent = 0, updated_at = now() WHERE id = $1`,
      [sourceId, targetId],
    )

    // 合并的项目若被其他项目指向，一并改指到最终目标
    await q('UPDATE wr_projects SET merged_into = $2 WHERE merged_into = $1', [sourceId, targetId])

    const [x, y] = pair(sourceId, targetId)
    await q(
      `INSERT INTO wr_project_relations (project_a, project_b, status, reason, confidence, evidence,
         source_project_id, target_project_id, merged_at, decided_by, decided_at)
       VALUES ($1,$2,'confirmed_same',$3,$4,$5,$6,$7,now(),$8,now())
       ON CONFLICT (project_a, project_b) DO UPDATE SET status = 'confirmed_same', reason = EXCLUDED.reason,
         confidence = EXCLUDED.confidence, source_project_id = EXCLUDED.source_project_id,
         target_project_id = EXCLUDED.target_project_id, merged_at = now(), decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [x, y, reason || null, confidence, JSON.stringify(evidence || {}), sourceId, targetId, by],
    )
    // 与源项目相关的未处理疑似重复关系，转到目标项目上重新判断
    await q(
      `UPDATE wr_alerts SET status = 'resolved', resolved_at = now()
       WHERE status = 'open' AND alert_type = 'possible_duplicate' AND dedupe_key IN ($1, $2)`,
      [`dup_${x}_${y}`, `dup_${y}_${x}`],
    )
  })
  await raiseAlert({
    category: 'data', type: 'project_merged', severity: 'info', projectId: targetId,
    title: `项目 #${sourceId} 已并入 #${targetId}（${reason || '确认相同'}）`,
    detail: { sourceId, targetId, reason, by }, dedupeKey: `merged_${sourceId}_${targetId}`,
  })
  return targetId
}

// 用户在冲突队列中做出判断
async function decideRelation(relationId, decision) {
  const rel = await db.one('SELECT * FROM wr_project_relations WHERE id = $1', [relationId])
  if (!rel) throw new Error('关系不存在')
  if (decision === 'same') {
    const target = Math.min(rel.project_a, rel.project_b)
    const source = Math.max(rel.project_a, rel.project_b)
    await mergeProjects(source, target, { reason: `人工确认相同（${rel.reason || ''}）`, confidence: 'high', by: 'user' })
  } else if (decision === 'different') {
    await db.query(
      `UPDATE wr_project_relations SET status = 'confirmed_different', decided_by = 'user', decided_at = now() WHERE id = $1`,
      [relationId],
    )
  } else {
    throw new Error('decision 只能是 same 或 different')
  }
  await db.query(
    `UPDATE wr_alerts SET status = 'resolved', resolved_at = now()
     WHERE status = 'open' AND alert_type = 'possible_duplicate' AND dedupe_key = $1`,
    [`dup_${rel.project_a}_${rel.project_b}`],
  )
  return { ok: true }
}

// 被合并的项目沿 merged_into 找到最终项目
async function resolveMerged(id) {
  let cur = id
  for (let i = 0; i < 10; i++) {
    const r = await db.one('SELECT merged_into FROM wr_projects WHERE id = $1', [cur])
    if (!r?.merged_into) return cur
    cur = r.merged_into
  }
  return cur
}

/**
 * upsertProject({ surfId, name, symbol, website, twitter, contracts:[{chain,address}], chains:[], category, source })
 * 返回 { id, created, merged:[被并入的项目ID], possibleDuplicates:[项目ID] }
 */
async function upsertProject(input) {
  const ids = buildIdentifiers(input)
  if (!ids.length && !input.name) throw new Error('项目缺少任何身份标识')

  let rows = []
  if (ids.length) {
    const conds = ids.map((_, i) => `(i.id_type = $${i * 2 + 1} AND i.id_value = $${i * 2 + 2})`).join(' OR ')
    rows = await db.query(
      `SELECT i.project_id, i.id_type FROM wr_project_ids i JOIN wr_projects p ON p.id = i.project_id
       WHERE p.merged_into IS NULL AND (${conds})`,
      ids.flat(),
    )
  }
  const { strong, weak } = classifyMatches(rows)
  // 本次输入同时带了域名和 X 账号时，分别命中两个项目也不算强匹配（各自只命中一项）

  const chains = [...new Set((input.chains || []).map(normalizeChain).filter(Boolean))]
  const domain = normalizeDomain(input.website)
  const twitter = normalizeTwitter(input.twitter)

  let id
  let created = false
  const merged = []

  if (strong.length === 0) {
    const r = await db.one(
      `INSERT INTO wr_projects (surf_project_id, name, symbol, website_domain, twitter_handle, category, chains, primary_chain, discovery_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.surfId || null, input.name, input.symbol || null, domain, twitter, input.category || null,
        JSON.stringify(chains), chains[0] || null, input.source || null],
    )
    id = r.id
    created = true
  } else {
    strong.sort((a, b) => a.projectId - b.projectId)
    id = strong[0].projectId
    // 多个项目都与本次输入强匹配 → 它们是同一项目，自动合并到 ID 最小的那个
    for (const s of strong.slice(1)) {
      const existing = await relationStatus(id, s.projectId)
      if (existing === 'confirmed_different') {
        // 用户明确判断过不同：不合并，改为告警提示数据源可能有误
        await raiseAlert({ category: 'data', type: 'identity_conflict', severity: 'warn', projectId: id,
          title: `#${id} 与 #${s.projectId} 已确认不同，但新数据的强标识同时指向两者`, detail: { input: ids },
          dedupeKey: `conflict_${id}_${s.projectId}` })
        continue
      }
      await mergeProjects(s.projectId, id, { reason: s.reasons.join('、'), confidence: 'high', by: 'auto', evidence: { identifiers: ids } })
      merged.push(s.projectId)
    }
    await db.query(
      `UPDATE wr_projects SET
         surf_project_id = COALESCE(surf_project_id, $2), symbol = COALESCE(symbol, $3),
         website_domain = COALESCE(website_domain, $4), twitter_handle = COALESCE(twitter_handle, $5),
         category = COALESCE(category, $6),
         chains = (SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb)
                   FROM jsonb_array_elements_text(COALESCE(chains,'[]'::jsonb) || $7::jsonb) AS c),
         primary_chain = COALESCE(primary_chain, $8), updated_at = now()
       WHERE id = $1`,
      [id, input.surfId || null, input.symbol || null, domain, twitter, input.category || null, JSON.stringify(chains), chains[0] || null],
    )
  }

  // 写入标识：强标识全局唯一（已被其他项目占用则跳过），弱标识按项目唯一
  for (const [type, value] of ids) {
    if (STRONG_TYPES.has(type)) {
      await db.query(
        `INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id_type, id_value) WHERE id_type IN ('surf_id','contract') DO NOTHING`,
        [id, type, value, input.source || null],
      )
    } else {
      await db.query(
        `INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id, id_type, id_value) DO NOTHING`,
        [id, type, value, input.source || null],
      )
    }
  }

  // 弱匹配：进入冲突队列，不合并
  const possibleDuplicates = []
  for (const w of weak) {
    if (w.projectId === id || merged.includes(w.projectId)) continue
    await flagPossibleDuplicate(id, w.projectId, w.reasons, { identifiers: ids })
    possibleDuplicates.push(w.projectId)
  }

  return { id, created, merged, possibleDuplicates }
}

module.exports = {
  upsertProject, mergeProjects, decideRelation, resolveMerged,
  normalizeDomain, normalizeTwitter, normalizeContract, normalizeChain, buildIdentifiers, PROJECT_REF_TABLES,
}
