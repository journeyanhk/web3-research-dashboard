// 项目身份确认、去重与合并
//
// 高置信度（自动合并）：Surf 项目 ID 相同；或同一条链上合约地址相同；或官网域名 + 官方 X 账号同时相同
// 低置信度（只进冲突队列，不合并）：只有域名相同、只有 X 账号相同、只有名称相同
// 特例：本次输入「只有名称」（例如从融资标题提取的项目名）且已有同名项目 → 直接挂到该项目，不新建也不入队
const MERGE_RULE_VERSION = 'identity-v1'
const db = require('./db')
const { raiseAlert } = require('./alerts')

const EVM_CHAINS = new Set(['ethereum', 'bsc', 'base', 'arbitrum', 'robinhood', 'polygon', 'optimism', 'avalanche'])
const STRONG_TYPES = new Set(['surf_id', 'contract'])

// 引用 project_id 的表：合并时统一迁移。后续里程碑新增的表（事件、评分、快照…）需要加到这里。
const PROJECT_REF_TABLES = ['wr_metrics', 'wr_alerts', 'wr_api_usage', 'wr_events', 'wr_stage_history', 'wr_notes', 'wr_screening_snapshots']
// 不需要迁移的表：身份标识单独处理；关系表本身记录合并历史
const PROJECT_REF_EXEMPT = ['wr_project_ids', 'wr_project_relations']

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

// 名称标准化：小写，去掉空格与常见标点（"Lighthouse.storage" / "lighthouse storage" 视为相同）
function normalizeName(name) {
  if (!name) return null
  const s = String(name).toLowerCase().normalize('NFKC').replace(/[\s._\-·•'’"“”()（）]+/g, '')
  return s.length >= 2 ? s : null
}

function buildIdentifiers(input) {
  const ids = []
  const n = normalizeName(input.name)
  if (n) ids.push(['name', n])
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
const WEAK_LABEL = { domain: '官网域名相同', twitter: 'X 账号相同', name: '名称相同' }

function classifyMatches(rows) {
  const per = new Map()
  for (const r of rows) {
    if (!per.has(r.project_id)) per.set(r.project_id, new Map())
    const m = per.get(r.project_id)
    if (!m.has(r.id_type)) m.set(r.id_type, [])
    m.get(r.id_type).push(r.id_value)
  }
  const strong = []
  const weak = []
  for (const [pid, typeMap] of per) {
    const reasons = []
    const matched = []
    if (typeMap.has('surf_id')) { reasons.push('Surf 项目 ID 相同'); matched.push(...typeMap.get('surf_id').map((v) => ({ type: 'surf_id', value: v }))) }
    if (typeMap.has('contract')) {
      reasons.push('合约地址相同')
      matched.push(...typeMap.get('contract').map((v) => { const [chain, ...a] = v.split(':'); return { type: 'contract', chain, address: a.join(':') } }))
    }
    if (typeMap.has('domain') && typeMap.has('twitter')) {
      reasons.push('官网域名与 X 账号同时相同')
      matched.push({ type: 'domain', value: typeMap.get('domain')[0] }, { type: 'twitter', value: typeMap.get('twitter')[0] })
    }
    if (reasons.length) strong.push({ projectId: pid, reasons, matched })
    else {
      weak.push({
        projectId: pid,
        types: [...typeMap.keys()],
        reasons: [...typeMap.keys()].map((t) => WEAK_LABEL[t] || t),
        matched: [...typeMap.entries()].flatMap(([type, vals]) => vals.map((value) => ({ type, value }))),
      })
    }
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
         tags = COALESCE(t.tags, s.tags),
         -- 链信息来源取可信度更高的一方（manual > surf_detail > airdrop_task > inferred）
         chain_source = CASE WHEN array_position(ARRAY['manual','surf_detail','contract_chain','airdrop_task','inferred'], s.chain_source)
                                < COALESCE(array_position(ARRAY['manual','surf_detail','contract_chain','airdrop_task','inferred'], t.chain_source), 99)
                             THEN s.chain_source ELSE t.chain_source END,
         last_signal_at = GREATEST(t.last_signal_at, s.last_signal_at),
         campaign_chains = (SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb)
                            FROM jsonb_array_elements_text(COALESCE(t.campaign_chains,'[]'::jsonb) || COALESCE(s.campaign_chains,'[]'::jsonb)) c),
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
    // 审计信息：命中的标识（合约含链与地址）、合并前名称与链、规则版本
    const audit = {
      ...(evidence || {}),
      merge_rule_version: MERGE_RULE_VERSION,
      source: { id: src.id, name: src.name, chains: src.chains, surf_project_id: src.surf_project_id },
      target: { id: tgt.id, name: tgt.name, chains: tgt.chains, surf_project_id: tgt.surf_project_id },
    }
    await q(
      `INSERT INTO wr_project_relations (project_a, project_b, status, reason, confidence, evidence,
         source_project_id, target_project_id, merged_at, decided_by, decided_at)
       VALUES ($1,$2,'confirmed_same',$3,$4,$5,$6,$7,now(),$8,now())
       ON CONFLICT (project_a, project_b) DO UPDATE SET status = 'confirmed_same', reason = EXCLUDED.reason,
         confidence = EXCLUDED.confidence, source_project_id = EXCLUDED.source_project_id,
         target_project_id = EXCLUDED.target_project_id, merged_at = now(), decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [x, y, reason || null, confidence, JSON.stringify(audit), sourceId, targetId, by],
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
    await mergeProjects(source, target, {
      reason: `人工确认相同（${rel.reason || ''}）`, confidence: 'high', by: 'user',
      evidence: { queue_evidence: rel.evidence || null },
    })
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
      `SELECT i.project_id, i.id_type, i.id_value FROM wr_project_ids i JOIN wr_projects p ON p.id = i.project_id
       WHERE p.merged_into IS NULL AND (${conds})`,
      ids.flat(),
    )
  }
  const { strong, weak } = classifyMatches(rows)
  // 本次输入同时带了域名和 X 账号时，分别命中两个项目也不算强匹配（各自只命中一项）

  // 只有名称的输入（M1.1）：
  //   唯一同名 → 挂过去；多个同名中唯一有强身份 → 挂到它；否则不做选择，返回 ambiguous 交给调用方（不新建、不默认取最早）
  const nameOnly = ids.length > 0 && ids.every(([t]) => t === 'name')
  if (nameOnly && strong.length === 0) {
    const sameName = weak.filter((w) => w.types.includes('name')).map((w) => w.projectId).sort((a, b) => a - b)
    if (sameName.length === 1) {
      await db.query('UPDATE wr_projects SET updated_at = now() WHERE id = $1', [sameName[0]])
      return { id: sameName[0], created: false, merged: [], possibleDuplicates: [], linkedBy: 'name' }
    }
    if (sameName.length > 1) {
      const st = await db.query(
        `SELECT DISTINCT project_id FROM wr_project_ids WHERE project_id = ANY($1) AND id_type IN ('surf_id','contract')`, [sameName])
      if (st.length === 1) return { id: st[0].project_id, created: false, merged: [], possibleDuplicates: [], linkedBy: 'name_disambiguated' }
      return { id: null, created: false, merged: [], possibleDuplicates: [], linkedBy: 'name_ambiguous', ambiguous: sameName }
    }
  }

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
      await mergeProjects(s.projectId, id, {
        reason: s.reasons.join('、'), confidence: 'high', by: 'auto',
        evidence: { matched_identifiers: s.matched, input_identifiers: ids.map(([type, value]) => ({ type, value })) },
      })
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

  await writeIdentifiers(id, ids, input.source)

  // 弱匹配：进入冲突队列，不合并
  const possibleDuplicates = []
  for (const w of weak) {
    if (w.projectId === id || merged.includes(w.projectId)) continue
    await flagPossibleDuplicate(id, w.projectId, w.reasons, { matched_identifiers: w.matched })
    possibleDuplicates.push(w.projectId)
  }

  return { id, created, merged, possibleDuplicates, linkedBy: strong.length ? 'strong' : created ? 'new' : 'weak' }
}

// 写入标识：强标识全局唯一（已被其他项目占用则跳过），弱标识按项目唯一
async function writeIdentifiers(id, ids, source) {
  for (const [type, value] of ids) {
    if (STRONG_TYPES.has(type)) {
      await db.query(
        `INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id_type, id_value) WHERE id_type IN ('surf_id','contract') DO NOTHING`,
        [id, type, value, source || null],
      )
    } else {
      await db.query(
        `INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (project_id, id_type, id_value) DO NOTHING`,
        [id, type, value, source || null],
      )
    }
  }
}

/**
 * 给已知项目补充身份（例如拉到项目详情后补官网、X 账号、合约）。
 * 强标识若已属于其他项目 → 两者是同一项目，自动合并（保留 ID 小的）；弱标识命中其他项目 → 进冲突队列。
 * 返回最终项目 ID（可能因合并而变化）。
 */
async function attachIdentity(projectId, input) {
  let id = await resolveMerged(projectId)
  const ids = buildIdentifiers(input)
  for (const [type, value] of ids.filter(([t]) => STRONG_TYPES.has(t))) {
    const owner = await db.one(
      `SELECT i.project_id FROM wr_project_ids i JOIN wr_projects p ON p.id = i.project_id
       WHERE i.id_type = $1 AND i.id_value = $2 AND p.merged_into IS NULL`,
      [type, value],
    )
    if (!owner || owner.project_id === id) continue
    if ((await relationStatus(id, owner.project_id)) === 'confirmed_different') {
      await raiseAlert({ category: 'data', type: 'identity_conflict', severity: 'warn', projectId: id,
        title: `#${id} 与 #${owner.project_id} 已确认不同，但 ${type === 'surf_id' ? 'Surf ID' : '合约'} 相同`,
        detail: { type, value }, dedupeKey: `conflict_${Math.min(id, owner.project_id)}_${Math.max(id, owner.project_id)}` })
      continue
    }
    const target = Math.min(id, owner.project_id)
    const source = Math.max(id, owner.project_id)
    const matched = type === 'contract'
      ? (() => { const [chain, ...a] = value.split(':'); return [{ type, chain, address: a.join(':') }] })()
      : [{ type, value }]
    await mergeProjects(source, target, {
      reason: type === 'surf_id' ? 'Surf 项目 ID 相同' : '合约地址相同', confidence: 'high', by: 'auto',
      evidence: { matched_identifiers: matched, via: 'attachIdentity' },
    })
    id = target
  }
  await writeIdentifiers(id, ids, input.source)

  // 弱标识命中其他项目 → 冲突队列
  const weakIds = ids.filter(([t]) => t === 'domain' || t === 'twitter')
  if (weakIds.length) {
    const conds = weakIds.map((_, i) => `(i.id_type = $${i * 2 + 2} AND i.id_value = $${i * 2 + 3})`).join(' OR ')
    const others = await db.query(
      `SELECT i.project_id, i.id_type, i.id_value FROM wr_project_ids i JOIN wr_projects p ON p.id = i.project_id
       WHERE p.merged_into IS NULL AND i.project_id <> $1 AND (${conds})`,
      [id, ...weakIds.flat()],
    )
    const { strong, weak } = classifyMatches(others)
    for (const s of strong) {
      // 官网 + X 账号同时命中另一个项目 → 高置信度合并
      const target = Math.min(id, s.projectId)
      const source = Math.max(id, s.projectId)
      if ((await relationStatus(target, source)) === 'confirmed_different') continue
      await mergeProjects(source, target, { reason: s.reasons.join('、'), confidence: 'high', by: 'auto', evidence: { matched_identifiers: s.matched, via: 'attachIdentity' } })
      id = target
    }
    for (const w of weak) await flagPossibleDuplicate(id, w.projectId, w.reasons, { matched_identifiers: w.matched })
  }

  const chains = [...new Set((input.chains || []).map(normalizeChain).filter(Boolean))]
  await db.query(
    `UPDATE wr_projects SET
       surf_project_id = COALESCE(surf_project_id, $2), symbol = COALESCE(symbol, $3),
       website_domain = COALESCE(website_domain, $4), twitter_handle = COALESCE(twitter_handle, $5),
       category = COALESCE(category, $6),
       chains = (SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb)
                 FROM jsonb_array_elements_text(COALESCE(chains,'[]'::jsonb) || $7::jsonb) AS c),
       primary_chain = COALESCE(primary_chain, $8), updated_at = now()
     WHERE id = $1`,
    [id, input.surfId || null, input.symbol || null, normalizeDomain(input.website), normalizeTwitter(input.twitter),
      input.category || null, JSON.stringify(chains), chains[0] || null],
  )
  return id
}

// 身份确认程度：confirmed（有 Surf ID 或合约）/ partial（有官网或 X 账号）/ name_only
async function identityStatus(projectIds) {
  if (!projectIds.length) return {}
  const rows = await db.query(
    `SELECT project_id, array_agg(DISTINCT id_type) AS types FROM wr_project_ids WHERE project_id = ANY($1) GROUP BY project_id`,
    [projectIds],
  )
  const out = {}
  for (const r of rows) {
    const t = new Set(r.types)
    out[r.project_id] = t.has('surf_id') || t.has('contract') ? 'confirmed' : t.has('domain') || t.has('twitter') ? 'partial' : 'name_only'
  }
  return out
}

// ───────── 链信息来源（M2.3）─────────
// 可信度：manual（人工确认）> surf_detail（Surf 项目详情 / 合约）> airdrop_task（空投任务所在链）> inferred（由标题或简介文字推断）
// 链来源可信度：人工 > Surf 详情 > 合约所在链 > 空投任务 > 文字推断
// 只有前三类代表项目实际部署链；空投任务所在链只是活动要求，不等于项目部署链（M2.3 Review P1）
const CHAIN_SOURCE_RANK = ['manual', 'surf_detail', 'contract_chain', 'airdrop_task', 'inferred']
const CONFIRMED_CHAIN_SOURCES = ['manual', 'surf_detail', 'contract_chain']
const CORE_CHAIN_IDS = ['ethereum', 'bsc', 'base', 'arbitrum', 'solana', 'robinhood']

/**
 * 写入链信息并记录来源：
 * - 新来源更可信（或当前无链）→ 用新链替换（例如项目详情覆盖文字推断的链）
 * - 来源同级 → 取并集
 * - 当前来源更可信 → 不改（manual 时总是替换）
 */
async function setChains(projectId, chains, source, q = db.query) {
  const list = [...new Set((chains || []).map(normalizeChain).filter(Boolean))]
  if (!list.length || !CHAIN_SOURCE_RANK.includes(source)) return false
  const cur = (await q('SELECT chains, chain_source FROM wr_projects WHERE id = $1', [projectId]))[0]
  if (!cur) return false
  const curChains = cur.chains || []
  const curRank = cur.chain_source ? CHAIN_SOURCE_RANK.indexOf(cur.chain_source) : 99
  const newRank = CHAIN_SOURCE_RANK.indexOf(source)
  let next
  if (source === 'manual' || !curChains.length || newRank < curRank) next = list
  else if (newRank === curRank) next = [...new Set([...curChains, ...list])]
  else return false
  const primary = next.find((c) => CORE_CHAIN_IDS.includes(c)) || next[0]
  await q(
    `UPDATE wr_projects SET chains = $2::jsonb, primary_chain = $3, chain_source = $4, updated_at = now() WHERE id = $1`,
    [projectId, JSON.stringify(next), primary, source],
  )
  return true
}

/** 记录空投 / 活动任务涉及的链（只用于展示和活动分析，不参与链状态、核心链加分和初筛） */
async function addCampaignChains(projectId, chains, q = db.query) {
  const list = [...new Set((chains || []).map(normalizeChain).filter(Boolean))]
  if (!projectId || !list.length) return false
  await q(
    `UPDATE wr_projects SET campaign_chains = (SELECT COALESCE(jsonb_agg(DISTINCT c), '[]'::jsonb)
       FROM jsonb_array_elements_text(COALESCE(campaign_chains,'[]'::jsonb) || $2::jsonb) c) WHERE id = $1`,
    [projectId, JSON.stringify(list)])
  return true
}

module.exports = {
  setChains, addCampaignChains, CHAIN_SOURCE_RANK, CONFIRMED_CHAIN_SOURCES,
  upsertProject, attachIdentity, mergeProjects, decideRelation, resolveMerged, identityStatus,
  normalizeDomain, normalizeTwitter, normalizeContract, normalizeChain, normalizeName, buildIdentifiers,
  PROJECT_REF_TABLES, PROJECT_REF_EXEMPT, MERGE_RULE_VERSION,
}
