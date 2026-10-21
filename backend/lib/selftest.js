// M0 验收自检：安全 / 数据（评分验收在 M3 完成）。全部使用真实数据。
const fs = require('node:fs')
const path = require('node:path')
const db = require('./db')
const registry = require('./registry')
const { call, callWithFallback, BudgetBlockedError } = require('./providers')
const { execSync } = require('node:child_process')
const { upsertProject, decideRelation } = require('./identity')
const { recordMetric } = require('./metrics')
const { secretValues, getSecret } = require('./config')

const ROOT = path.join(__dirname, '..', '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vulcan', 'uploads', '.claude'])
// 任何以 .env 开头的文件都不扫描（它们本来就存放密钥），但必须保证没有被 Git 跟踪
const isEnvFile = (name) => name.startsWith('.env')
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' // Jupiter（SOL 真实代币，用于连通性验证）

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out)
    } else if (!isEnvFile(ent.name)) out.push(path.join(dir, ent.name))
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
  for (const [key, label] of [['SURF_API_KEY', 'Surf API Key'], ['HELIUS_API_KEY', 'Helius API Key'], ['DATABASE_URL', '数据库连接']]) {
    await step(results, '安全', `${label} 已配置`, async () => {
      assert(getSecret(key), `未找到 ${key}`)
      return '已配置（只在环境中）'
    })
  }
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
  await step(results, '安全', '密钥文件没有被 Git 跟踪', async () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    assert(/^\.env\.\*$/m.test(gi) && /^\.env$/m.test(gi), '.gitignore 未排除 .env / .env.*')
    let tracked = []
    try {
      tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n')
        .filter((f) => /(^|\/)\.env/.test(f) && !/\.env\.example$/.test(f))
    } catch (e) {
      throw new Error(`无法读取 Git 跟踪文件：${e.message.slice(0, 120)}`)
    }
    assert(tracked.length === 0, `以下密钥文件被 Git 跟踪：${tracked.join(', ')}`)
    return '.env / .env.* 均未被跟踪（仅 .env.example）'
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
  await step(results, '数据', '数据库读写', async () => {
    const key = `rw_${Date.now()}`
    await db.query("INSERT INTO wr_registry (kind, key, value) VALUES ('selftest', $1, $2)", [key, JSON.stringify({ ok: true })])
    const r = await db.one("SELECT value FROM wr_registry WHERE kind = 'selftest' AND key = $1", [key])
    await db.query("DELETE FROM wr_registry WHERE kind = 'selftest' AND key = $1", [key])
    assert(r?.value?.ok === true, '写入后读不到')
    const m = await db.one('SELECT count(*)::int c FROM wr_migrations')
    return `写入 → 读取 → 删除正常；已应用 ${m.c} 个迁移`
  })
  let surfProjectId = null
  let tmpProjectId = null
  let tmpRelationId = null
  await step(results, '数据', 'Surf 调用并记账', async () => {
    const r = await call({ provider: 'surf', endpoint: 'search/project', params: { q: 'uniswap', limit: 1 }, trigger, task })
    const item = r.body?.data?.[0]
    assert(item?.id && item?.name, 'Surf 返回格式不符合预期（缺少 id / name）')
    surfProjectId = item.id
    const u = await db.one(
      `SELECT actual_credits::float a, estimated_credits::float e FROM wr_api_usage WHERE raw_id = $1 AND status = 'ok'`, [r.rawId])
    assert(u, '调用没有记账')
    const raw = await db.one("SELECT status, body IS NOT NULL AS has_body FROM wr_raw_responses WHERE id = $1", [r.rawId])
    assert(raw?.status === 'ok' && raw.has_body, '原始响应没有存档')
    return `返回「${item.name}」；预估 ${u.e} 点，实际 ${u.a} 点；记账与存档 #${r.rawId} 正常`
  })
  await step(results, '数据', '重复请求命中缓存（不花点数）', async () => {
    const r = await call({ provider: 'surf', endpoint: 'search/project', params: { q: 'uniswap', limit: 1 }, trigger, task, cacheTtlSec: 3600 })
    assert(r.cached && r.credits === 0, '未命中缓存')
    return `命中存档 #${r.rawId}，消耗 0 点`
  })
  await step(results, '数据', 'Helius 调用并单独记账', async () => {
    const r = await call({ provider: 'helius', endpoint: 'getAsset', params: { id: JUP }, trigger, task })
    const name = r.body?.result?.content?.metadata?.name
    assert(name, 'Helius 返回格式不符合预期（缺少代币名称）')
    const u = await db.one(`SELECT actual_credits::float a FROM wr_api_usage WHERE raw_id = $1 AND provider = 'helius'`, [r.rawId])
    assert(u, 'Helius 调用没有记账')
    return `返回「${name}」，消耗 ${u.a} Helius credits，已单独记账`
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
    assert(contracts.length > 0, '项目没有合约地址，无法测试强匹配')
    const second = await upsertProject({
      name: name.toUpperCase(),
      contracts: contracts.map((c) => ({ chain: c.chain, address: /^0x/.test(c.address) ? c.address.toUpperCase().replace('0X', '0x') : c.address })),
      source: 'selftest',
    })
    assert(first.id === second.id, `生成了两个项目：#${first.id} / #${second.id}`)
    const cnt = await db.one('SELECT count(*)::int c FROM wr_projects WHERE surf_project_id = $1', [surfProjectId])
    assert(cnt.c === 1, `同一 Surf ID 有 ${cnt.c} 条记录`)
    return `两次写入都指向项目 #${first.id}（合约地址相同 → 高置信度识别为同一项目）`
  })
  await step(results, '数据', '只有 X 账号相同 → 进冲突队列，不自动合并', async () => {
    const base = await db.one('SELECT id, name, twitter_handle FROM wr_projects WHERE surf_project_id = $1 AND merged_into IS NULL', [surfProjectId])
    assert(base?.twitter_handle, '基准项目缺少 X 账号，无法测试')
    const r = await upsertProject({ name: `${base.name}（自检临时记录）`, twitter: base.twitter_handle, source: 'selftest_tmp' })
    tmpProjectId = r.id
    assert(r.created && r.id !== base.id, '弱匹配被直接合并了')
    assert(r.possibleDuplicates.includes(base.id), '没有进入冲突队列')
    const rel = await db.one(`SELECT id, status FROM wr_project_relations WHERE project_a = $1 AND project_b = $2`, [Math.min(base.id, r.id), Math.max(base.id, r.id)])
    assert(rel?.status === 'possible_duplicate', '冲突关系没有记录')
    tmpRelationId = rel.id
    return `新建临时项目 #${r.id}，与 #${base.id} 记为「疑似重复」，未合并`
  })
  await step(results, '数据', '确认相同 → 合并并迁移数据', async () => {
    assert(tmpRelationId && tmpProjectId, '缺少上一步的临时记录')
    // 给临时项目挂一条指标，验证合并时会迁移
    await recordMetric({ projectId: tmpProjectId, name: 'selftest_marker', value: 1, source: 'selftest' })
    await decideRelation(tmpRelationId, 'same')
    const p = await db.one('SELECT merged_into, stage FROM wr_projects WHERE id = $1', [tmpProjectId])
    const base = await db.one('SELECT id FROM wr_projects WHERE surf_project_id = $1 AND merged_into IS NULL', [surfProjectId])
    assert(p?.merged_into === base.id && p.stage === 'merged', '临时项目没有并入')
    const moved = await db.one(`SELECT count(*)::int c FROM wr_metrics WHERE project_id = $1 AND metric_name = 'selftest_marker'`, [base.id])
    assert(moved.c >= 1, '指标没有迁移到目标项目')
    const rel = await db.one('SELECT status, merged_at FROM wr_project_relations WHERE id = $1', [tmpRelationId])
    assert(rel.status === 'confirmed_same' && rel.merged_at, '合并记录缺失')
    return `#${tmpProjectId} 已并入 #${base.id}，指标已迁移，合并记录已保存`
  })
  // 清理自检临时数据
  if (tmpProjectId) {
    await db.query("DELETE FROM wr_metrics WHERE metric_name = 'selftest_marker'")
    await db.query('DELETE FROM wr_project_relations WHERE project_a = $1 OR project_b = $1', [tmpProjectId])
    await db.query("DELETE FROM wr_alerts WHERE project_id = $1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3",
      [tmpProjectId, `%\_${tmpProjectId}`, `merged\_${tmpProjectId}\_%`])
    await db.query('DELETE FROM wr_projects WHERE id = $1', [tmpProjectId])
  }

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
