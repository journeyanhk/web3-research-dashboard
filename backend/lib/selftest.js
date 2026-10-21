// M0 验收自检：安全 / 数据（评分验收在 M3 完成）。全部使用真实数据。
const fs = require('node:fs')
const path = require('node:path')
const db = require('./db')
const registry = require('./registry')
const { call, callWithFallback, BudgetBlockedError } = require('./providers')
const { upsertProject } = require('./identity')
const { recordMetric } = require('./metrics')
const { secretValues } = require('./config')

const ROOT = path.join(__dirname, '..', '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vulcan', 'uploads', '.claude'])
const SKIP_FILES = new Set(['.env', '.env.local'])
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' // Jupiter（SOL 真实代币，用于连通性验证）

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out)
    } else if (!SKIP_FILES.has(ent.name)) out.push(path.join(dir, ent.name))
  }
  return out
}

async function step(results, group, name, fn) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ group, name, ok: true, detail, ms: Date.now() - t })
  } catch (e) {
    results.push({ group, name, ok: false, detail: e.message, ms: Date.now() - t })
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function runSelftest() {
  const results = []
  const trigger = 'selftest'
  const task = 'm0_selftest'
  const secrets = secretValues()

  // ───── 安全 ─────
  await step(results, '安全', '密钥已配置（只在环境中）', async () => {
    const names = []
    if (process.env.HELIUS_API_KEY) names.push('Helius')
    if (process.env.SURF_API_KEY) names.push('Surf')
    assert(names.includes('Helius'), '未找到 HELIUS_API_KEY')
    return `已配置：${names.join('、')}`
  })
  await step(results, '安全', '代码文件中不包含任何密钥', async () => {
    const files = walk(ROOT)
    const hits = []
    for (const f of files) {
      let txt
      try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
      if (secrets.some((s) => txt.includes(s))) hits.push(path.relative(ROOT, f))
      if (/github_pat_[A-Za-z0-9_]{20,}/.test(txt)) hits.push(`${path.relative(ROOT, f)}（GitHub Token 格式）`)
    }
    assert(hits.length === 0, `发现密钥：${hits.join(', ')}`)
    return `已扫描 ${files.length} 个文件`
  })
  await step(results, '安全', '.gitignore 排除了密钥文件', async () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    assert(/\.env/.test(gi), '.gitignore 未包含 .env')
    return '.env / .env.local 已排除'
  })
  await step(results, '安全', '调用记录与原始存档中不包含密钥', async () => {
    let n = 0
    for (const s of secrets) {
      const a = await db.one('SELECT count(*)::int c FROM wr_api_usage WHERE params::text LIKE $1 OR coalesce(error,\'\') LIKE $1', [`%${s}%`])
      const b = await db.one('SELECT count(*)::int c FROM wr_raw_responses WHERE params::text LIKE $1 OR coalesce(error,\'\') LIKE $1', [`%${s}%`])
      n += a.c + b.c
    }
    assert(n === 0, `有 ${n} 条记录包含密钥`)
    return '未发现'
  })

  // ───── 数据 ─────
  let surfProjectId = null
  await step(results, '数据', 'Surf 调用并记账', async () => {
    const r = await call({ provider: 'surf', endpoint: 'search/project', params: { q: 'uniswap', limit: 1 }, trigger, task })
    const item = r.body?.data?.[0]
    assert(item?.id, 'Surf 未返回项目')
    surfProjectId = item.id
    return `返回「${item.name}」，消耗 ${r.credits} 点，存档 #${r.rawId}`
  })
  await step(results, '数据', '重复请求命中缓存（不花点数）', async () => {
    const r = await call({ provider: 'surf', endpoint: 'search/project', params: { q: 'uniswap', limit: 1 }, trigger, task, cacheTtlSec: 3600 })
    assert(r.cached && r.credits === 0, '未命中缓存')
    return `命中存档 #${r.rawId}，消耗 0 点`
  })
  await step(results, '数据', 'Helius 调用并单独记账', async () => {
    const r = await call({ provider: 'helius', endpoint: 'getAsset', params: { id: JUP }, trigger, task })
    const name = r.body?.result?.content?.metadata?.name
    assert(name, 'Helius 未返回代币信息')
    return `返回「${name}」，消耗 ${r.credits} Helius credits`
  })
  await step(results, '数据', '主源失败 → 切换备用源并标记', async () => {
    const fb = await callWithFallback([
      // 故意请求一个不存在的路径，模拟 DexScreener 故障
      { provider: 'dexscreener', endpoint: '/__selftest_unavailable__', params: {} },
      {
        provider: 'geckoterminal', endpoint: `/networks/solana/tokens/${JUP}`, params: {},
        parse: (b) => (b?.data?.attributes?.price_usd != null ? Number(b.data.attributes.price_usd) : null),
      },
    ], { trigger, task })
    assert(fb.fallbackUsed && fb.source === 'geckoterminal', '没有切换到备用源')
    const failedRaw = fb.attempts.find((a) => !a.ok)?.rawId
    const raw = failedRaw ? await db.one('SELECT status FROM wr_raw_responses WHERE id = $1', [failedRaw]) : null
    assert(raw?.status === 'error', '失败请求的原始记录没有保存')
    const mid = await recordMetric({ chain: 'solana', subject: JUP, name: 'price_usd', value: fb.value, unit: 'USD',
      source: fb.source, primarySource: fb.primarySource, fallbackUsed: true, fallbackReason: fb.fallbackReason, confidence: 0.8, rawId: fb.rawId })
    const m = await db.one('SELECT fallback_used, source, primary_source FROM wr_metrics WHERE id = $1', [mid])
    assert(m.fallback_used === true, '指标没有标记备用源')
    return `主源 ${m.primary_source} 失败（原始记录 #${failedRaw} 已保存），已用 ${m.source}，价格 $${Number(fb.value).toFixed(4)}，指标已标记「使用备用源」`
  })
  await step(results, '数据', '同一项目不会重复建档', async () => {
    assert(surfProjectId, '缺少 Surf 项目 ID')
    const r = await call({ provider: 'surf', endpoint: 'project/detail', params: { id: surfProjectId }, trigger, task, cacheTtlSec: 86400 })
    const d = r.body?.data || {}
    const twitter = d.social?.twitter?.handle
    const contracts = (d.contracts?.contracts || []).filter((c) => c?.address && c?.chain).slice(0, 3)
    const name = d.overview?.name || 'Uniswap'
    const first = await upsertProject({ surfId: surfProjectId, name, twitter, contracts, chains: d.overview?.chains, source: 'selftest' })
    // 第二次：不带 Surf ID，只用大写的 X 账号 + 改变大小写的合约地址
    const second = await upsertProject({
      name: name.toUpperCase(),
      twitter: twitter ? `https://x.com/${twitter.toUpperCase()}` : undefined,
      contracts: contracts.map((c) => ({ chain: c.chain, address: /^0x/.test(c.address) ? c.address.toUpperCase().replace('0X', '0x') : c.address })),
      source: 'selftest',
    })
    assert(first.id === second.id, `生成了两个项目：#${first.id} / #${second.id}`)
    const cnt = await db.one('SELECT count(*)::int c FROM wr_projects WHERE surf_project_id = $1', [surfProjectId])
    assert(cnt.c === 1, `同一 Surf ID 有 ${cnt.c} 条记录`)
    return `两次写入都指向项目 #${first.id}（用 X 账号 / 合约地址识别出同一项目）`
  })
  await step(results, '数据', '超出预算的请求会被拦截', async () => {
    try {
      await call({ provider: 'surf', endpoint: 'search/project', params: { q: 'budget-guard-test' }, trigger, task, estCost: 1e9 })
    } catch (e) {
      if (e instanceof BudgetBlockedError) return `已拦截：${e.message}`
      throw e
    }
    throw new Error('请求没有被拦截')
  })
  await step(results, '数据', '链能力矩阵与覆盖率', async () => {
    const chains = await registry.list('chain')
    const weights = await registry.getSetting('coverage_weights')
    const cov = chains.filter((c) => c.status !== 'paused')
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => `${c.name} ${Math.round(registry.chainCoverage(c, weights).coverage * 100)}%`)
    return cov.join('，')
  })

  results.push({ group: '评分', name: '三个真实项目的评分验收', ok: null, detail: '评分模块在 M3 完成后执行（ETH / SOL / Robinhood Chain 各一个）' })

  const summary = {
    ran_at: new Date().toISOString(),
    passed: results.filter((r) => r.ok === true).length,
    failed: results.filter((r) => r.ok === false).length,
    results,
  }
  await registry.set('setting', 'last_selftest', summary)
  return summary
}

module.exports = { runSelftest }
