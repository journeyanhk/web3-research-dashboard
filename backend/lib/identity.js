// 项目身份确认与去重：Surf ID / 官网域名 / X 账号 / 合约地址 任一命中即视为同一项目
const db = require('./db')
const { raiseAlert } = require('./alerts')

const EVM_CHAINS = new Set(['ethereum', 'bsc', 'base', 'arbitrum', 'robinhood', 'polygon', 'optimism', 'avalanche'])

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

/**
 * upsertProject({ surfId, name, symbol, website, twitter, contracts:[{chain,address}], chains:[], category, source })
 * 返回 { id, created, conflict }
 */
async function upsertProject(input) {
  const ids = buildIdentifiers(input)
  if (!ids.length && !input.name) throw new Error('项目缺少任何身份标识')

  let matches = []
  if (ids.length) {
    const conds = ids.map((_, i) => `(id_type = $${i * 2 + 1} AND id_value = $${i * 2 + 2})`).join(' OR ')
    matches = await db.query(`SELECT DISTINCT project_id FROM wr_project_ids WHERE ${conds}`, ids.flat())
  }
  const projectIds = [...new Set(matches.map((m) => m.project_id))]
  let id
  let created = false
  let conflict = false

  const chains = [...new Set((input.chains || []).map(normalizeChain).filter(Boolean))]
  const domain = normalizeDomain(input.website)
  const twitter = normalizeTwitter(input.twitter)

  if (projectIds.length === 0) {
    const r = await db.one(
      `INSERT INTO wr_projects (surf_project_id, name, symbol, website_domain, twitter_handle, category, chains, primary_chain, discovery_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.surfId || null, input.name, input.symbol || null, domain, twitter, input.category || null,
        JSON.stringify(chains), chains[0] || null, input.source || null],
    )
    id = r.id
    created = true
  } else {
    id = Math.min(...projectIds)
    if (projectIds.length > 1) {
      conflict = true
      await raiseAlert({ category: 'data', type: 'identity_conflict', severity: 'warn', projectId: id,
        title: `${input.name} 的身份标识指向多个项目，可能重复`, detail: { projectIds, identifiers: ids },
        dedupeKey: `identity_${projectIds.sort().join('_')}` })
    }
    await db.query(
      `UPDATE wr_projects SET
         surf_project_id = COALESCE(surf_project_id, $2), symbol = COALESCE(symbol, $3),
         website_domain = COALESCE(website_domain, $4), twitter_handle = COALESCE(twitter_handle, $5),
         category = COALESCE(category, $6),
         chains = (SELECT to_jsonb(array(SELECT DISTINCT jsonb_array_elements_text(COALESCE(chains,'[]'::jsonb) || $7::jsonb)))),
         primary_chain = COALESCE(primary_chain, $8), updated_at = now()
       WHERE id = $1`,
      [id, input.surfId || null, input.symbol || null, domain, twitter, input.category || null, JSON.stringify(chains), chains[0] || null],
    )
  }

  for (const [type, value] of ids) {
    await db.query(
      `INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id_type, id_value) DO NOTHING`,
      [id, type, value, input.source || null],
    )
  }
  return { id, created, conflict }
}

module.exports = { upsertProject, normalizeDomain, normalizeTwitter, normalizeContract, normalizeChain, buildIdentifiers }
