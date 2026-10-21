// M1 全局发现：融资 / 公募 / 空投 / 上币 / 新闻 → 事件入库 → 身份确认 → 项目详情补全
//
// 试跑期规模（可在配置 discovery_config 中调整）：融资 ≤50 条、空投 ≤50 条、新闻 ≤100 条、上币 ≤100 条，
// 每次运行最多按名称查找 15 个项目身份、补全 10 个项目详情。
const db = require('../db')
const registry = require('../registry')
const { call, BudgetBlockedError } = require('../providers')
const identity = require('../identity')
const { recordMetric } = require('../metrics')
const x = require('./extract')

const CORE_CHAINS = ['ethereum', 'bsc', 'base', 'arbitrum', 'solana', 'robinhood']
const EXTRACTION_RULE_VERSION = 'extract-v1'
const DETAIL_RETRY_DAYS = 30
// 这些事件出现时，Surf 查不到详情的项目允许提前重试一次
const RETRY_TRIGGER_EVENTS = new Set(['fundraising', 'public_sale', 'listing', 'tge'])

const DEFAULT_CONFIG = {
  lookback_days: 3,
  fundraising_limit: 50,
  fundraising_pages: 1,
  min_importance: 3, // 融资事件重要度 ≥ 3 才去确认项目身份
  airdrop_limit: 50,
  airdrop_min_xscore: 50, // 空投：无 Surf 记录且无融资时，社交分 ≥ 50 才建项目
  news_limit: 50,
  news_pages: 2,
  listing_limit: 100,
  resolve_per_run: 15, // 每次运行最多按名称查 Surf 身份的次数（1 点/次）
  detail_per_run: 10, // 每次运行最多补全项目详情的数量（1 点/个）
  research_cooldown_days: 7, // 同一项目按名称查找身份的冷却期
}

const AIRDROP_STATUS_ZH = {
  POTENTIAL: '潜在', CONFIRMED: '已确认', SNAPSHOT: '已快照', VERIFICATION: '验证中', REWARD_AVAILABLE: '可领取', DISTRIBUTED: '已发放',
}
const TGE_STATUS_ZH = { pre: 'TGE 前', upcoming: '即将 TGE', post: '已 TGE' }

const ts = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : null)
const isoDate = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => new Date(Date.now() - n * 86400000)

async function loadConfig() {
  const saved = await registry.getSetting('discovery_config')
  return { ...DEFAULT_CONFIG, ...(saved || {}) }
}

// 统一的 Surf 调用：预算被拦截后，本次运行不再发起新的付费请求
async function surf(ctx, endpoint, params, opts = {}) {
  if (ctx.budgetBlocked) throw new BudgetBlockedError(ctx.budgetBlocked)
  try {
    return await call({ provider: 'surf', endpoint, params, trigger: ctx.trigger, ...opts })
  } catch (e) {
    if (e instanceof BudgetBlockedError && e.scope !== 'project') ctx.budgetBlocked = e.message
    throw e
  }
}

async function insertEvent(ev) {
  const r = await db.one(
    `INSERT INTO wr_events (project_id, event_type, external_id, provider, endpoint, title, summary, url, source_name, importance,
       chains, candidate_name, candidate_symbol, link_method, link_confidence, excluded_reason, event_at, published_at, data, raw_id)
     VALUES ($1,$2,$3,'surf',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (event_type, external_id) DO NOTHING RETURNING id`,
    [ev.projectId || null, ev.type, String(ev.externalId), ev.endpoint || null, ev.title || null, ev.summary || null,
      ev.url || null, ev.sourceName || null, ev.importance ?? null, JSON.stringify(ev.chains || []), ev.candidateName || null,
      ev.candidateSymbol || null, ev.linkMethod || 'none', ev.linkConfidence || 'none', ev.excludedReason || null,
      ev.eventAt || null, ev.publishedAt || null, JSON.stringify(ev.data || {}), ev.rawId || null],
  )
  return r ? r.id : null
}

async function linkEvent(eventId, link) {
  await db.query(
    'UPDATE wr_events SET project_id = $2, link_method = $3, link_confidence = $4, link_evidence = $5 WHERE id = $1',
    [eventId, link.projectId || null, link.method, link.confidence, link.evidence ? JSON.stringify(link.evidence) : null],
  )
  if (!link.projectId) return
  // Surf 曾查不到详情的项目，出现新的关键事件时允许提前重试一次
  const ev = await db.one('SELECT event_type FROM wr_events WHERE id = $1', [eventId])
  if (ev && RETRY_TRIGGER_EVENTS.has(ev.event_type)) {
    await db.query(
      `UPDATE wr_projects SET detail_retry_after = now()
       WHERE id = $1 AND detail_not_found_at IS NOT NULL AND (detail_retry_after IS NULL OR detail_retry_after > now())`,
      [link.projectId],
    )
  }
}

/**
 * 同名项目处理（M1.1）：
 * - 0 个：返回 null，由调用方决定查 Surf 或新建
 * - 1 个：关联，但只算低置信度（method = name）
 * - 多个：其中只有 1 个有强身份（Surf ID / 合约 / 官网+X）→ 关联它（name_disambiguated，中置信度）；
 *         否则不自动关联（name_ambiguous），进入名称歧义队列等人工选择
 */
async function matchByName(norm) {
  const rows = await db.query(
    `SELECT p.id, p.name, p.surf_project_id, p.surf_searched_at,
            array_agg(DISTINCT i2.id_type) AS id_types
     FROM wr_project_ids i JOIN wr_projects p ON p.id = i.project_id
     LEFT JOIN wr_project_ids i2 ON i2.project_id = p.id
     WHERE i.id_type = 'name' AND i.id_value = $1 AND p.merged_into IS NULL
     GROUP BY p.id ORDER BY p.id`,
    [norm],
  )
  if (rows.length === 0) return { kind: 'none', candidates: [] }
  const candidates = rows.map((r) => {
    const t = new Set(r.id_types || [])
    const strong = t.has('surf_id') || t.has('contract') || (t.has('domain') && t.has('twitter'))
    return { id: r.id, name: r.name, strong, surf_project_id: r.surf_project_id, surf_searched_at: r.surf_searched_at, id_types: [...t] }
  })
  const evidenceBase = { matched_name: norm, candidate_projects: candidates.map((c) => ({ id: c.id, name: c.name, strong_identity: c.strong })) }
  if (candidates.length === 1) {
    return { kind: 'single', project: candidates[0], evidence: { ...evidenceBase, selected_project: candidates[0].id, selection_reason: '唯一同名项目（仅名称，低置信度）' } }
  }
  const strong = candidates.filter((c) => c.strong)
  if (strong.length === 1) {
    return { kind: 'disambiguated', project: strong[0], evidence: { ...evidenceBase, selected_project: strong[0].id, selection_reason: '多个同名项目中唯一有强身份标识的' } }
  }
  return { kind: 'ambiguous', candidates, evidence: { ...evidenceBase, selected_project: null, selection_reason: strong.length > 1 ? '多个同名项目都有强身份，无法自动判断' : '多个同名项目都没有强身份，无法自动判断' } }
}

/**
 * 按名称确认项目身份：
 * 1) 已有同名项目 → 直接关联；若该项目还没有 Surf ID，冷却期外再到 Surf 查一次
 * 2) Surf 名称/slug 完全一致 → 带 Surf ID 建档（或给同名项目补上 Surf ID）
 * 3) Surf 查不到 → 仅名称建档（早期项目很常见），身份状态为「仅名称」
 */
async function resolveByName(ctx, name, chains, source, { search = true } = {}) {
  const norm = identity.normalizeName(name)
  if (!norm) return null
  const m = await matchByName(norm)

  // 多个同名且无法区分：不关联，交给人工
  if (m.kind === 'ambiguous') {
    ctx.stats.identity.ambiguous = (ctx.stats.identity.ambiguous || 0) + 1
    return { projectId: null, method: 'name_ambiguous', confidence: 'none', created: false, evidence: m.evidence }
  }

  const existing = m.project || null
  const cooldownMs = ctx.cfg.research_cooldown_days * 86400000
  const needSearch = search && (!existing || (!existing.surf_project_id &&
    (!existing.surf_searched_at || Date.now() - new Date(existing.surf_searched_at).getTime() > cooldownMs)))

  let hit = null
  if (needSearch && ctx.resolveLeft > 0 && !ctx.budgetBlocked) {
    ctx.resolveLeft--
    try {
      const r = await surf(ctx, 'search/project', { q: name, limit: 5 },
        { task: 'identity_resolve', cacheTtlSec: 7 * 86400, projectId: existing?.id })
      hit = (r.body?.data || []).find((p) => p?.id && (identity.normalizeName(p.name) === norm || identity.normalizeName(p.slug) === norm)) || null
      ctx.stats.identity.searched++
    } catch (e) {
      if (!(e instanceof BudgetBlockedError)) ctx.stats.identity.errors++
    }
    if (existing) await db.query('UPDATE wr_projects SET surf_searched_at = now() WHERE id = $1', [existing.id])
  }

  if (existing) {
    let id = existing.id
    if (hit) id = await identity.attachIdentity(existing.id, { surfId: hit.id, symbol: hit.symbol, chains: hit.chains, source })
    if (!hit && chains.length) await addChainsIfEmpty(id, chains)
    if (hit) {
      return { projectId: id, method: 'name_search', confidence: 'medium', created: false,
        evidence: { ...m.evidence, selection_reason: `${m.evidence.selection_reason}；Surf 名称完全一致，已补充 Surf ID` } }
    }
    return m.kind === 'disambiguated'
      ? { projectId: id, method: 'name_disambiguated', confidence: 'medium', created: false, evidence: m.evidence }
      : { projectId: id, method: 'name', confidence: 'low', created: false, evidence: m.evidence }
  }
  if (hit) {
    const u = await identity.upsertProject({ surfId: hit.id, name: hit.name, symbol: hit.symbol, chains: hit.chains, source })
    await db.query(
      `UPDATE wr_projects SET logo_url = COALESCE(logo_url, $2), description = COALESCE(description, $3), surf_searched_at = now() WHERE id = $1`,
      [u.id, hit.logo_url || null, hit.description || null],
    )
    return { projectId: u.id, method: 'name_search', confidence: 'medium', created: u.created,
      evidence: { matched_name: norm, selection_reason: 'Surf 名称完全一致', surf_project_id: hit.id } }
  }
  const u = await identity.upsertProject({ name, chains, source })
  if (needSearch) await db.query('UPDATE wr_projects SET surf_searched_at = now() WHERE id = $1', [u.id])
  return { projectId: u.id, method: 'name', confidence: 'low', created: u.created,
    evidence: { matched_name: norm, selection_reason: u.created ? '无同名项目，Surf 中也未找到，仅名称建档' : '仅名称' } }
}

// 由标题推断的链只在项目还没有链信息时写入（低置信度，后续以项目详情为准）
async function addChainsIfEmpty(projectId, chains) {
  await db.query(
    `UPDATE wr_projects SET chains = $2::jsonb, primary_chain = COALESCE(primary_chain, $3)
     WHERE id = $1 AND jsonb_array_length(COALESCE(chains,'[]'::jsonb)) = 0`,
    [projectId, JSON.stringify(chains), chains[0] || null],
  )
}

// ───────── 融资 / 公募 ─────────
async function collectFundraising(ctx) {
  const st = (ctx.stats.fundraising = { fetched: 0, new: 0, excluded: 0, low_importance: 0, linked: 0, created: 0 })
  const { cfg } = ctx
  for (let page = 0; page < cfg.fundraising_pages; page++) {
    const r = await surf(ctx, 'search/fundraising',
      { lang: 'zh', limit: cfg.fundraising_limit, offset: page * cfg.fundraising_limit, from: isoDate(daysAgo(cfg.lookback_days)), sort_by: 'recency' },
      { task: 'discovery_fundraising', cacheTtlSec: 1800 })
    const items = r.body?.data || []
    st.fetched += items.length
    for (const it of items) {
      if (!it?.id || !it?.title) continue
      const title = it.title
      const summary = it.summary || ''
      const excluded = x.exclusionReason(title, summary)
      const name = x.extractLeadName(title)
      const chains = x.detectChains(title, summary)
      const type = x.isPublicSale(title, summary) ? 'public_sale' : 'fundraising'
      const importance = it.importance ?? null
      const lowImportance = importance == null || importance < cfg.min_importance
      const eventId = await insertEvent({
        type, externalId: it.id, endpoint: 'search/fundraising', title, summary, url: it.source?.url,
        sourceName: it.source?.name, importance, chains, candidateName: name,
        excludedReason: excluded || (lowImportance ? `重要度低于 ${cfg.min_importance}` : !name ? '无法从标题识别项目名' : null),
        eventAt: ts(it.event_at), publishedAt: ts(it.published_at), rawId: r.rawId,
        data: {
          amount_usd: x.parseUsdAmount(`${title} ${summary}`), round: x.parseRound(`${title} ${summary}`),
          lead: x.parseLead(`${title} ${summary}`), source_type: it.source?.type, source_count: it.source_count,
          extraction: { rule_version: EXTRACTION_RULE_VERSION, candidate_name_raw: name, candidate_name_normalized: identity.normalizeName(name) },
        },
      })
      if (!eventId) continue // 已处理过
      st.new++
      if (excluded) { st.excluded++; continue }
      if (lowImportance || !name) { st.low_importance++; continue }
      const link = await resolveByName(ctx, name, chains, type)
      if (link) {
        await linkEvent(eventId, link)
        if (link.projectId) {
          st.linked++
          if (link.created) st.created++
          ctx.touched.add(link.projectId)
        } else st.ambiguous = (st.ambiguous || 0) + 1
      }
    }
    if (items.length < cfg.fundraising_limit || !r.body?.meta?.has_more) break
  }
}

// ───────── 空投 ─────────
async function collectAirdrops(ctx) {
  const st = (ctx.stats.airdrop = { fetched: 0, new: 0, low_signal: 0, linked: 0, created: 0 })
  const { cfg } = ctx
  const r = await surf(ctx, 'search/airdrop',
    { limit: cfg.airdrop_limit, sort_by: 'last_status_update', order: 'desc', include_tasks: true },
    { task: 'discovery_airdrop', cacheTtlSec: 1800 })
  const items = r.body?.data || []
  st.fetched = items.length
  for (const it of items) {
    if (!it?.project_name) continue
    const name = it.project_name
    const chains = [...new Set((it.tasks || []).flatMap((t) => t?.blockchains || []).map(identity.normalizeChain).filter(Boolean))]
    const totalRaise = Number(it.total_raise || 0)
    const xscore = Number(it.xscore || 0)
    const admit = !!it.project_id || totalRaise > 0 || xscore >= cfg.airdrop_min_xscore
    const eventId = await insertEvent({
      type: 'airdrop', externalId: `${it.project_id || identity.normalizeName(name)}:${it.status}`, endpoint: 'search/airdrop',
      title: `${name} · ${AIRDROP_STATUS_ZH[it.status] || it.status}`, chains, candidateName: name, candidateSymbol: it.coin_symbol,
      excludedReason: admit ? null : '低信号（无 Surf 记录、无融资、社交分低）',
      eventAt: ts(it.last_status_update), publishedAt: ts(it.last_status_update), rawId: r.rawId,
      url: (it.tasks || []).find((t) => t?.external_link)?.external_link,
      data: {
        status: it.status, reward_type: it.reward_type, reward_date: it.reward_date || null, total_raise: totalRaise,
        xscore, followers: it.followers_count, surf_project_id: it.project_id || null,
        task_summary: it.task_summary || null, task_types: [...new Set((it.tasks || []).map((t) => t?.type).filter(Boolean))],
        open_tasks: (it.tasks || []).filter((t) => t?.status === 'OPEN').length,
      },
    })
    if (!eventId) continue
    st.new++
    if (!admit) { st.low_signal++; continue }
    let link
    if (it.project_id) {
      const u = await identity.upsertProject({ surfId: it.project_id, name, symbol: it.coin_symbol, chains, source: 'airdrop' })
      if (it.logo_url) await db.query('UPDATE wr_projects SET logo_url = COALESCE(logo_url, $2) WHERE id = $1', [u.id, it.logo_url])
      link = { projectId: u.id, method: 'surf_id', confidence: 'high', created: u.created, evidence: { surf_project_id: it.project_id } }
    } else {
      // 没有 Surf 记录的空投项目通常 Surf 也查不到，不再按名称查找（省点数）
      link = await resolveByName(ctx, name, chains, 'airdrop', { search: false })
    }
    if (link) {
      await linkEvent(eventId, link)
      if (link.projectId) {
        st.linked++
        if (link.created) st.created++
        ctx.touched.add(link.projectId)
      } else st.ambiguous = (st.ambiguous || 0) + 1
    }
  }
}

// ───────── 上币（含盘前合约，TGE 信号）─────────
async function collectListings(ctx) {
  const st = (ctx.stats.listing = { fetched: 0, new: 0, linked: 0 })
  const r = await surf(ctx, 'market/listing',
    { from: isoDate(daysAgo(ctx.cfg.lookback_days)), limit: ctx.cfg.listing_limit, product: 'all', type: 'listing' },
    { task: 'discovery_listing', cacheTtlSec: 1800 })
  const items = r.body?.data || []
  st.fetched = items.length
  for (const it of items) {
    if (!it?.trading_pair || !it?.exchange_name) continue
    const base = it.base_symbol || it.trading_pair.split('/')[0]
    const eventId = await insertEvent({
      type: 'listing', externalId: `${it.exchange_name}:${it.product}:${it.trading_pair}:${it.effective_at}`, endpoint: 'market/listing',
      title: `${it.exchange_name} 上线 ${it.trading_pair}（${it.product}）`, candidateSymbol: base,
      eventAt: ts(it.effective_at), publishedAt: ts(it.published_at || it.effective_at), rawId: r.rawId,
      data: { exchange: it.exchange_name, pair: it.trading_pair, product: it.product, quote: it.quote_symbol, event_type: it.event_type },
    })
    if (!eventId) continue
    st.new++
    // 只按代币符号关联已有项目，且必须唯一（符号重复很常见，不据此建项目）
    const m = await db.query(
      'SELECT id FROM wr_projects WHERE merged_into IS NULL AND upper(symbol) = upper($1) LIMIT 2', [base])
    if (m.length === 1) {
      await linkEvent(eventId, { projectId: m[0].id, method: 'symbol', confidence: 'low' })
      st.linked++
    }
  }
}

// ───────── 新闻（只关联已有项目，不建项目）─────────
async function collectNews(ctx) {
  const st = (ctx.stats.news = { fetched: 0, new: 0, linked: 0 })
  const state = (await registry.get('job', 'discovery')) || {}
  const from = state.news_watermark ? Number(state.news_watermark) - 600 : Math.floor(daysAgo(1).getTime() / 1000)
  let maxPublished = state.news_watermark || 0
  for (let page = 0; page < ctx.cfg.news_pages; page++) {
    const r = await surf(ctx, 'news/feed', { limit: ctx.cfg.news_limit, offset: page * ctx.cfg.news_limit, from },
      { task: 'discovery_news', cacheTtlSec: 1800 })
    const items = r.body?.data || []
    st.fetched += items.length
    for (const it of items) {
      if (!it?.id || !it?.title) continue
      maxPublished = Math.max(maxPublished, Number(it.published_at || 0))
      const eventId = await insertEvent({
        type: 'news', externalId: it.id, endpoint: 'news/feed', title: it.title, summary: it.summary, url: it.url,
        sourceName: it.source, candidateName: it.project_name, eventAt: ts(it.published_at), publishedAt: ts(it.published_at),
        rawId: r.rawId, data: { surf_project_id: it.project_id || null },
      })
      if (!eventId) continue
      st.new++
    }
    if (items.length < ctx.cfg.news_limit) break
  }
  ctx.newsWatermark = nextWatermark(state.news_watermark, maxPublished)
}

// 新闻水位只前进不后退
function nextWatermark(prev, observedMax) {
  return Math.max(Number(prev || 0), Number(observedMax || 0)) || null
}

// 把未关联的新闻按 Surf 项目 ID 关联到已有项目（每次运行都补一遍，新建的项目也能拿到历史新闻）
async function relinkNews(ctx) {
  const rows = await db.query(
    `UPDATE wr_events e SET project_id = i.project_id, link_method = 'surf_id', link_confidence = 'high'
     FROM wr_project_ids i JOIN wr_projects p ON p.id = i.project_id AND p.merged_into IS NULL
     WHERE e.event_type = 'news' AND e.project_id IS NULL AND i.id_type = 'surf_id' AND i.id_value = e.data->>'surf_project_id'
     RETURNING e.id`,
  )
  if (ctx.stats.news) ctx.stats.news.linked += rows.length
}

// ───────── 身份确认：为新项目拉项目详情（官网、X、合约、链、TGE 状态、代币数据）─────────
async function enrichDetails(ctx) {
  const st = (ctx.stats.detail = { candidates: 0, fetched: 0, merged: 0, tge_events: 0, errors: 0 })
  const rows = await detailCandidates(ctx.cfg.detail_per_run)
  st.candidates = rows.length
  for (const p of rows) {
    if (ctx.budgetBlocked) break
    let d
    let rawId
    try {
      const r = await surf(ctx, 'project/detail', { id: p.surf_project_id },
        { task: 'identity_detail', projectId: p.id, cacheTtlSec: 7 * 86400 })
      d = r.body?.data
      rawId = r.rawId
    } catch (e) {
      if (e instanceof BudgetBlockedError) {
        // 单项目上限拦截只跳过该项目；全局预算拦截则停止
        if (e.scope === 'project') { st.project_capped = (st.project_capped || 0) + 1; continue }
        break
      }
      if (e.status === 404) {
        // Surf 中已没有该项目：标记后不再重复请求（避免每天浪费点数）
        await markDetailNotFound(p.id)
        st.not_found = (st.not_found || 0) + 1
        continue
      }
      st.errors++
      continue
    }
    if (!d) { st.errors++; continue }
    st.fetched++
    const contracts = (d.contracts?.contracts || []).filter((c) => c?.chain && c?.address)
    const finalId = await identity.attachIdentity(p.id, {
      surfId: p.surf_project_id, website: d.overview?.website, twitter: d.social?.twitter?.handle,
      contracts, chains: [...(d.overview?.chains || []), ...contracts.map((c) => c.chain)], symbol: d.overview?.token_symbol || d.token_info?.symbol, source: 'project_detail',
    })
    if (finalId !== p.id) st.merged++
    const tge = d.tge_status || {}
    const tgeStatus = tge.current_status || d.overview?.tge_status || null
    await db.query(
      `UPDATE wr_projects SET detail_fetched_at = now(), detail_not_found_at = NULL, detail_retry_after = NULL,
         flags = COALESCE(flags,'[]'::jsonb) - 'detail_not_found',
         tge_status = COALESCE($2, tge_status), tge_exchanges = COALESCE($3, tge_exchanges),
         description = COALESCE(description, $4), logo_url = COALESCE(logo_url, $5), updated_at = now()
       WHERE id = $1`,
      [finalId, tgeStatus, tge.exchanges ? JSON.stringify(tge.exchanges) : null, d.overview?.description || null,
        d.overview?.logo_url || d.token_info?.image || null],
    )
    if (tgeStatus === 'pre' || tgeStatus === 'upcoming') {
      const ev = await insertEvent({
        type: 'tge', externalId: `${p.surf_project_id}:${tgeStatus}`, endpoint: 'project/detail', projectId: finalId,
        title: `${p.name} · ${TGE_STATUS_ZH[tgeStatus]}`, linkMethod: 'surf_id', linkConfidence: 'high',
        eventAt: ts(tge.last_event_time) || new Date().toISOString(), rawId,
        data: { status: tgeStatus, exchanges: tge.exchanges || [] },
      })
      if (ev) st.tge_events++
    }
    // 代币与社交基础数据（只追加，后续评分使用）
    const tk = d.tokenomics || {}
    const metricsToSave = [
      ['fdv_usd', tk.fdv ?? d.token_info?.fdv, 'USD'], ['market_cap_usd', tk.market_cap_usd, 'USD'],
      ['circulating_supply', tk.circulating_supply, null], ['total_supply', tk.total_supply, null],
      ['twitter_followers', d.social?.twitter?.followers_count, null],
    ]
    for (const [name, value, unit] of metricsToSave) {
      if (value == null || Number.isNaN(Number(value))) continue
      await recordMetric({ projectId: finalId, name, value: Number(value), unit, source: 'surf', confidence: 0.8, rawId })
    }
    ctx.touched.add(finalId)
  }
}

// 需要补全详情的项目：从未拉过，或 Surf 曾查不到但已到重试时间
async function detailCandidates(limit) {
  return db.query(
    `SELECT id, name, surf_project_id FROM wr_projects
     WHERE merged_into IS NULL AND surf_project_id IS NOT NULL
       AND (detail_fetched_at IS NULL OR (detail_not_found_at IS NOT NULL AND detail_retry_after <= now()))
     ORDER BY (chain_priority = 'core') DESC NULLS LAST, first_seen_at DESC LIMIT $1`,
    [limit],
  )
}

async function markDetailNotFound(projectId) {
  await db.query(
    `UPDATE wr_projects SET detail_fetched_at = now(), detail_not_found_at = now(),
       detail_retry_after = now() + ($2 || ' days')::interval,
       flags = (SELECT COALESCE(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(flags,'[]'::jsonb) || '["detail_not_found"]'::jsonb) f)
     WHERE id = $1`, [projectId, String(DETAIL_RETRY_DAYS)])
}

// 链优先级：涉及 6 条核心链之一 → core；有链信息但不在其中 → other；没有链信息 → unknown
async function refreshChainPriority() {
  await db.query(
    `UPDATE wr_projects SET chain_priority = CASE
       WHEN chains ?| $1::text[] THEN 'core'
       WHEN jsonb_array_length(COALESCE(chains,'[]'::jsonb)) > 0 THEN 'other'
       ELSE 'unknown' END
     WHERE merged_into IS NULL`,
    [CORE_CHAINS],
  )
  await db.query(
    `UPDATE wr_projects p SET last_event_at = e.m
     FROM (SELECT project_id, max(event_at) m FROM wr_events WHERE project_id IS NOT NULL GROUP BY 1) e
     WHERE p.id = e.project_id AND (p.last_event_at IS NULL OR p.last_event_at < e.m)`,
  )
}

let running = null

async function runDiscovery({ trigger = 'auto' } = {}) {
  if (running) return { skipped: true, reason: '已有采集任务在运行' }
  running = (async () => {
    const cfg = await loadConfig()
    const run = await db.one(`INSERT INTO wr_job_runs (job, trigger, status) VALUES ('discovery', $1, 'running') RETURNING id`, [trigger])
    const ctx = {
      trigger, cfg, budgetBlocked: null, resolveLeft: cfg.resolve_per_run, touched: new Set(),
      stats: { identity: { searched: 0, errors: 0 } }, errors: [],
    }
    const creditsBefore = await db.one(
      `SELECT COALESCE(sum(actual_credits),0)::float c FROM wr_api_usage WHERE provider = 'surf'`)
    const steps = [
      ['融资', collectFundraising], ['空投', collectAirdrops], ['上币', collectListings], ['新闻', collectNews],
      ['身份确认', enrichDetails], ['新闻关联', relinkNews],
    ]
    for (const [label, fn] of steps) {
      try {
        await fn(ctx)
      } catch (e) {
        ctx.errors.push(`${label}：${e.message}`)
      }
    }
    try { await refreshChainPriority() } catch (e) { ctx.errors.push(`链优先级：${e.message}`) }
    const creditsAfter = await db.one(
      `SELECT COALESCE(sum(actual_credits),0)::float c FROM wr_api_usage WHERE provider = 'surf'`)
    const stats = { ...ctx.stats, surf_credits: +(creditsAfter.c - creditsBefore.c).toFixed(2), budget_blocked: ctx.budgetBlocked, errors: ctx.errors }
    const status = ctx.errors.length === 0 && !ctx.budgetBlocked ? 'ok' : ctx.errors.length >= steps.length ? 'error' : 'partial'
    await db.query(
      `UPDATE wr_job_runs SET status = $2, finished_at = now(), stats = $3, error = $4 WHERE id = $1`,
      [run.id, status, JSON.stringify(stats), ctx.errors.join('\n') || null],
    )
    const prev = (await registry.get('job', 'discovery')) || {}
    await registry.set('job', 'discovery', {
      ...prev, last_run_id: run.id, last_run_at: new Date().toISOString(), last_status: status,
      news_watermark: ctx.newsWatermark || prev.news_watermark || null,
    })
    return { runId: run.id, status, stats }
  })().finally(() => { running = null })
  return running
}

const isRunning = () => !!running

module.exports = {
  runDiscovery, isRunning, DEFAULT_CONFIG, CORE_CHAINS, EXTRACTION_RULE_VERSION,
  // 供自检使用的内部函数
  _internal: { resolveByName, matchByName, insertEvent, linkEvent, surf, detailCandidates, markDetailNotFound, nextWatermark },
}
