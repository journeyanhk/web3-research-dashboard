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
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vulcan', 'uploads', '.claude', 'secrets', 'outputs'])
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
  await step(results, '安全', '发布包会带上运行密钥（secrets/runtime.json）', async () => {
    // Surf 发布时剔除所有 .env* 文件；生产环境靠 secrets/runtime.json
    const rt = path.join(ROOT, 'backend', 'secrets', 'runtime.json')
    if (!fs.existsSync(rt)) {
      // 生产环境里也应该存在；不存在说明发布包里缺密钥
      throw new Error('缺少 backend/secrets/runtime.json，发布后生产环境将没有密钥')
    }
    const keys = Object.keys(JSON.parse(fs.readFileSync(rt, 'utf8')))
    const need = ['DATABASE_URL', 'HELIUS_API_KEY', 'ADMIN_PASSWORD', 'AUTH_SECRET']
    const miss = need.filter((k) => !keys.includes(k))
    assert(miss.length === 0, `runtime.json 缺少：${miss.join(', ')}`)
    assert(!keys.includes('GITHUB_TOKEN'), 'runtime.json 不应包含 GitHub Token')
    return `包含 ${keys.length} 项（不含 GitHub Token）`
  })
  for (const [key, label] of [['SURF_API_KEY', 'Surf API Key'], ['HELIUS_API_KEY', 'Helius API Key'], ['DATABASE_URL', '数据库连接'], ['ADMIN_PASSWORD', '登录密码']]) {
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
        .filter((f) => (/(^|\/)\.env/.test(f) && !/\.env\.example$/.test(f)) || (/^backend\/secrets\//.test(f) && !/README\.md$/.test(f)) || /^outputs\//.test(f))
    } catch (e) {
      throw new Error(`无法读取 Git 跟踪文件：${e.message.slice(0, 120)}`)
    }
    assert(tracked.length === 0, `以下密钥文件被 Git 跟踪：${tracked.join(', ')}`)
    return '.env / .env.* / secrets/runtime.json / 发布包 outputs/ 均未被跟踪'
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

  await step(results, '数据', '合并迁移覆盖所有引用项目的表', async () => {
    const { PROJECT_REF_TABLES, PROJECT_REF_EXEMPT } = require('./identity')
    const rows = await db.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'project_id' AND table_name LIKE 'wr\\_%'`)
    const all = rows.map((r) => r.table_name)
    const missing = all.filter((t) => !PROJECT_REF_TABLES.includes(t) && !PROJECT_REF_EXEMPT.includes(t))
    assert(missing.length === 0, `以下表含 project_id 但合并时不会迁移：${missing.join(', ')}`)
    return `${all.length} 张表含 project_id，均已纳入合并迁移或明确豁免`
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

  // ───── 边界（M1.1）：用临时项目验证，跑完全部清理 ─────
  await boundaryTests(results)
  // ───── 部署前检查（M2.1）─────
  await deployTests(results)

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

async function boundaryTests(results) {
  const { _internal: D, DEFAULT_CONFIG } = require('./collect/discovery')
  const budget = require('./budget')
  const tag = `wrst${Date.now()}`
  const name = `WR自检同名项目${tag}`
  const norm = require('./identity').normalizeName(name)
  const tmp = []
  const newCtx = () => ({ trigger: 'selftest', cfg: DEFAULT_CONFIG, resolveLeft: 0, budgetBlocked: null,
    stats: { identity: { searched: 0, errors: 0 } }, touched: new Set() })
  const mkProject = async () => {
    const r = await db.one(`INSERT INTO wr_projects (name, discovery_source) VALUES ($1, 'selftest_tmp') RETURNING id`, [name])
    await db.query(`INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1, 'name', $2, 'selftest_tmp')`, [r.id, norm])
    tmp.push(r.id)
    return r.id
  }
  try {
    const p1 = await mkProject()
    await step(results, '边界', '唯一同名项目 → 关联但只算低置信度', async () => {
      const l = await D.resolveByName(newCtx(), name, [], 'selftest_tmp', { search: false })
      assert(l.projectId === p1 && l.method === 'name' && l.confidence === 'low', `结果不符：${JSON.stringify(l)}`)
      return `关联到 #${p1}，方式「仅名称」，置信度低`
    })
    const p2 = await mkProject()
    await step(results, '边界', '多个同名且都无强身份 → 不自动关联', async () => {
      const l = await D.resolveByName(newCtx(), name, [], 'selftest_tmp', { search: false })
      assert(l.projectId == null && l.method === 'name_ambiguous', `被自动关联了：${JSON.stringify(l)}`)
      assert(l.evidence?.candidate_projects?.length === 2, '证据中缺少候选项目')
      const u = await require('./identity').upsertProject({ name, source: 'selftest_tmp' })
      assert(u.id == null && u.linkedBy === 'name_ambiguous', 'upsertProject 仍默认选了最早的项目')
      return `进入名称歧义队列，候选 #${p1}、#${p2}；没有默认选最早的项目`
    })
    await step(results, '边界', '多个同名中唯一有强身份 → 关联它（中置信度）', async () => {
      await db.query(`INSERT INTO wr_project_ids (project_id, id_type, id_value, source) VALUES ($1, 'surf_id', $2, 'selftest_tmp')`, [p2, `${tag}-surf`])
      const l = await D.resolveByName(newCtx(), name, [], 'selftest_tmp', { search: false })
      assert(l.projectId === p2 && l.method === 'name_disambiguated' && l.confidence === 'medium', `结果不符：${JSON.stringify(l)}`)
      assert(l.evidence?.selection_reason, '缺少选择理由')
      return `关联到有 Surf ID 的 #${p2}，并记录选择理由`
    })
    await step(results, '边界', '同一事件重复采集不会重复入库', async () => {
      const a = await D.insertEvent({ type: 'fundraising', externalId: `${tag}-dup`, title: 'selftest' })
      const b = await D.insertEvent({ type: 'fundraising', externalId: `${tag}-dup`, title: 'selftest' })
      assert(a && b == null, '重复事件被再次写入')
      return '第二次写入被忽略'
    })
    await step(results, '边界', '新闻水位只前进不后退', async () => {
      assert(D.nextWatermark(200, 100) === 200 && D.nextWatermark(100, 300) === 300 && D.nextWatermark(null, 0) === null, '水位计算错误')
      return '旧水位 200 + 新数据 100 → 仍为 200'
    })
    await step(results, '边界', 'Surf 查不到详情后不会每天重复请求', async () => {
      await db.query('UPDATE wr_projects SET surf_project_id = $2 WHERE id = $1', [p1, `${tag}-404`])
      await D.markDetailNotFound(p1)
      let c = await D.detailCandidates(100000)
      assert(!c.some((r) => r.id === p1), '标记 404 后仍在待补全列表中')
      const ev = await D.insertEvent({ type: 'fundraising', externalId: `${tag}-retry`, title: 'selftest' })
      await D.linkEvent(ev, { projectId: p1, method: 'name', confidence: 'low' })
      c = await D.detailCandidates(100000)
      assert(c.some((r) => r.id === p1), '出现新融资事件后没有允许重试')
      return '标记后 30 天内不再请求；出现新融资事件时允许重试一次'
    })
    await step(results, '边界', '全局预算拦截后不再发起请求', async () => {
      const before = await db.one(`SELECT count(*)::int c FROM wr_api_usage WHERE task = $1`, [`${tag}-guard`])
      const ctx = { ...newCtx(), budgetBlocked: '模拟：今日预算已用完' }
      let blocked = false
      try { await D.surf(ctx, 'search/project', { q: 'x' }, { task: `${tag}-guard` }) } catch (e) { blocked = e.blocked === true }
      const after = await db.one(`SELECT count(*)::int c FROM wr_api_usage WHERE task = $1`, [`${tag}-guard`])
      assert(blocked && after.c === before.c, '拦截后仍然发出了请求')
      return '直接拒绝，没有产生任何调用记录'
    })
    await step(results, '边界', '单项目到上限只影响该项目', async () => {
      const capSetting = (await registry.getSetting('surf_budget'))?.stage_total_caps?.discovery ?? 3
      await db.query('UPDATE wr_projects SET credits_spent = $2 WHERE id = $1', [p1, capSetting])
      const v1 = await budget.check({ provider: 'surf', trigger: 'auto', projectId: p1, estCost: 1, silent: true })
      const v2 = await budget.check({ provider: 'surf', trigger: 'auto', projectId: p2, estCost: 1, silent: true })
      assert(!v1.allowed && v1.scope === 'project', `项目 #${p1} 没有被单项目上限拦截`)
      assert(v2.allowed || v2.scope !== 'project', `项目 #${p2} 被错误拦截`)
      return `#${p1} 被拦截（单项目上限 ${capSetting} 点），#${p2} ${v2.allowed ? '正常放行' : `受全局限制：${v2.reason}`}`
    })
    // ───── 漏斗（M2）─────
    const pipeline = require('./pipeline')
    const base = (o = {}) => ({
      project: { name: `自检项目${tag}`, tge_status: null }, tags: [], metrics: {}, flags: [], evidence: [],
      identity: 'confirmed', conflict: false, chainStatus: 'core_confirmed', chains: ['base'], chainSource: 'surf_detail',
      qualityFunding: false, productLevel: null, lastSignalAt: new Date().toISOString(),
      hard: { credible_funding: false, verifiable_product: false, token_plan: false, onchain_activity: null, ecosystem_integration: null },
      bonus: { core_chain: false, multi_source: false, active_campaign: false, social_traction: false },
      completeness: {}, origins: {}, ...o,
    })
    // 满足条件的组合：融资（Surf 融资数据）+ 核心链（Surf 项目数据）= 2 个独立来源
    const ok2 = () => ({
      hard: { ...base().hard, credible_funding: true }, bonus: { ...base().bonus, core_chain: true },
      origins: { credible_funding: ['surf_fundraising'], core_chain: ['surf_project'] },
    })
    await step(results, '漏斗', '同一条记录的多个字段只算 1 个来源 → 不进初筛', async () => {
      const d = pipeline.decideStage(base({
        hard: { ...base().hard, verifiable_product: true }, bonus: { ...base().bonus, active_campaign: true },
        origins: { verifiable_product: ['surf_project'], active_campaign: ['surf_project'] },
      }))
      assert(d.stage === 'pending_verify' && d.facts.independence_groups.length === 1, `进入了 ${d.stage}，独立来源 ${d.facts.independence_groups.length}`)
      return `→ 待验证：${d.reason}`
    })
    await step(results, '漏斗', '「多个独立数据集」本身不额外算一个来源', async () => {
      const d = pipeline.decideStage(base({
        hard: { ...base().hard, credible_funding: true }, bonus: { ...base().bonus, multi_source: true },
        origins: { credible_funding: ['surf_fundraising'], multi_source: ['surf_project'] },
      }))
      assert(d.stage !== 'screening' && d.facts.independence_groups.length === 1, `进入了 ${d.stage}`)
      return `只有 1 个独立来源 → ${d.stage}`
    })
    await step(results, '漏斗', '硬条件 + 加分 + 2 个独立来源 + 核心链已确认 → 初筛', async () => {
      const d = pipeline.decideStage(base(ok2()))
      assert(d.stage === 'screening' && d.facts.qualifies, `进入了 ${d.stage}`)
      assert(d.facts.screening_rule_version === pipeline.SCREENING_RULE_VERSION, '快照缺少初筛口径版本')
      return `→ 初筛（口径 ${d.facts.screening_rule_version}）`
    })
    await step(results, '漏斗', '链状态：推断 → 待验证；无链 → 待补全；其他链 → 机会链', async () => {
      const a = pipeline.decideStage(base({ ...ok2(), chainStatus: 'inferred' }))
      const b = pipeline.decideStage(base({ ...ok2(), chainStatus: 'none', chains: [] }))
      const c = pipeline.decideStage(base({ ...ok2(), chainStatus: 'other_confirmed', chains: ['hyperliquid'] }))
      const e = pipeline.decideStage(base({ chainStatus: 'none', chains: [], qualityFunding: true, productLevel: 'high' }))
      assert(a.stage === 'pending_verify' && b.stage === 'data_incomplete' && c.stage === 'opportunity_chain', `结果：${a.stage} / ${b.stage} / ${c.stage}`)
      assert(e.stage === 'pending_verify' && e.facts.focus === true, `高质量融资 + 产品但无链应为待验证重点，实际 ${e.stage}`)
      assert(pipeline.chainStatusOf(['base'], 'inferred') === 'inferred' && pipeline.chainStatusOf(['base'], 'manual') === 'core_confirmed'
        && pipeline.chainStatusOf(['sui'], 'surf_detail') === 'other_confirmed' && pipeline.chainStatusOf([], 'manual') === 'none', '链状态计算错误')
      return '推断链 → 待验证；无链 → 数据待补全；其他链 → 机会链；无链但融资 + 产品 → 待验证重点'
    })
    await step(results, '漏斗', '成熟度：成熟 / 公链本身 → 非早期；已上市 → 已上市观察；新 L2 → 机会链', async () => {
      const m = pipeline.decideStage(base({ ...ok2(), project: { name: 'X', tge_status: 'post' }, metrics: { market_cap_usd: 5e8 } }))
      const l = pipeline.decideStage(base({ ...ok2(), project: { name: 'X', tge_status: 'post' }, metrics: { market_cap_usd: 2e7 } }))
      const k = pipeline.decideStage(base({ ...ok2(), project: { name: 'Base', tge_status: null } }))
      const n = pipeline.decideStage(base({ ...ok2(), tags: ['Layer2 & Scaling'] }))
      assert(m.stage === 'non_early' && m.facts.maturity === 'mature', `成熟项目：${m.stage}`)
      assert(l.stage === 'listed_watch' && l.facts.maturity === 'listed', `已上市：${l.stage}`)
      assert(k.stage === 'non_early' && k.facts.maturity === 'chain_infrastructure', `核心链本身：${k.stage}`)
      assert(n.stage === 'opportunity_chain', `新 L2：${n.stage}`)
      return '市值 5 亿 → 非早期；市值 2000 万 → 已上市观察；Base → 非早期；L2 标签 → 机会链'
    })
    await step(results, '漏斗', 'Review P1：只有空投任务所在链（Solana）→ 链待核实，不进初筛', async () => {
      const cs = pipeline.chainStatusOf(['solana'], 'airdrop_task')
      const d = pipeline.decideStage(base({ ...ok2(), chainStatus: cs, chains: ['solana'], chainSource: 'airdrop_task' }))
      assert(cs === 'inferred', `空投任务链被算成 ${cs}`)
      assert(d.stage !== 'screening' && d.stage === 'pending_verify' && /空投任务/.test(d.reason), `进入了 ${d.stage}：${d.reason}`)
      assert(pipeline.chainStatusOf(['base'], 'contract_chain') === 'core_confirmed', '合约所在链应算已确认')
      assert(!pipeline.CONFIRMED_CHAIN_SOURCES.includes('airdrop_task'), '空投任务仍在已确认来源里')
      return `空投链 → ${cs}，阶段 ${d.stage}；合约所在链 → 核心链已确认`
    })
    await step(results, '漏斗', 'Review P2：只有市值 > 0 → 不算已上市；TGE 已完成或确认上币 → 已上市', async () => {
      const a = pipeline.decideStage(base({ ...ok2(), project: { name: 'X', tge_status: null }, metrics: { market_cap_usd: 2e7 } }))
      const b = pipeline.decideStage(base({ ...ok2(), project: { name: 'X', tge_status: null }, metrics: { market_cap_usd: 5e8, fdv_usd: 1e9 } }))
      const c = pipeline.decideStage(base({ ...ok2(), project: { name: 'X', tge_status: null }, metrics: { market_cap_usd: 2e7 }, listingLevel: 'confirmed' }))
      assert(a.stage === 'screening' && a.facts.maturity !== 'listed' && a.facts.listing_evidence_level === 'inferred'
        && a.facts.market_data_suggests_listed === true, `仅市值 2000 万：${a.stage} / ${a.facts.maturity}`)
      assert(b.stage !== 'non_early' && b.stage !== 'listed_watch', `仅市值 5 亿被移出早期池：${b.stage}`)
      assert(c.stage === 'listed_watch' && c.facts.listing_evidence_level === 'confirmed', `确认上币：${c.stage}`)
      assert(pipeline.listingLevelOf({ tgeStatus: 'post', metrics: {} }) === 'confirmed' && pipeline.listingLevelOf({ metrics: {} }) === 'none', '上市证据分级错误')
      return `仅市值 → ${a.stage}（标记「可能已上市待核实」）；仅市值 5 亿 → ${b.stage}；确认上币 → 已上市观察`
    })
    await step(results, '漏斗', 'Review P1（库内）：空投任务链只记入「空投活动涉及的链」，项目链状态为待核实', async () => {
      const identity = require('./identity')
      const p4 = (await db.one(`INSERT INTO wr_projects (name, discovery_source) VALUES ($1, 'selftest_tmp') RETURNING id`, [`WR自检空投链${tag}`])).id
      tmp.push(p4)
      await identity.addCampaignChains(p4, ['solana'])
      await identity.setChains(p4, ['solana'], 'airdrop_task')
      await pipeline.evaluateProjects([p4])
      const r = await db.one('SELECT chain_status, chain_source, campaign_chains, stage FROM wr_projects WHERE id = $1', [p4])
      assert(r.chain_status === 'inferred' && (r.campaign_chains || []).includes('solana') && r.stage !== 'screening', `结果：${JSON.stringify(r)}`)
      await identity.setChains(p4, ['base'], 'contract_chain')
      const r2 = await db.one('SELECT chains, chain_source FROM wr_projects WHERE id = $1', [p4])
      assert(r2.chain_source === 'contract_chain' && r2.chains.includes('base'), '合约所在链没有覆盖空投任务链')
      return `链状态 ${r.chain_status}，空投活动链 ${JSON.stringify(r.campaign_chains)}；之后合约链（base）优先覆盖`
    })
    await step(results, '漏斗', '休眠 / 归档阈值：14 天休眠，30 天归档，初筛不自动休眠', async () => {
      const ago = (d) => new Date(Date.now() - d * 86400000).toISOString()
      const a = pipeline.decideStage(base({ lastSignalAt: ago(13) }))
      const b = pipeline.decideStage(base({ lastSignalAt: ago(15) }))
      const c = pipeline.decideStage(base({ lastSignalAt: ago(31) }))
      const d = pipeline.decideStage(base({ ...ok2(), lastSignalAt: ago(60) }))
      assert(a.stage === 'discovered' && b.stage === 'dormant' && c.stage === 'archived' && d.stage === 'screening',
        `结果：${a.stage} / ${b.stage} / ${c.stage} / ${d.stage}`)
      assert(b.facts.would_be_stage === 'discovered', '休眠时没有记录原阶段')
      return '13 天 → 发现；15 天 → 休眠；31 天 → 归档；初筛 60 天仍为初筛'
    })
    await step(results, '漏斗', '身份只有名称 → 数据待补全；有冲突 → 数据冲突', async () => {
      const a = pipeline.decideStage(base({ ...ok2(), identity: 'name_only' }))
      const b = pipeline.decideStage(base({ ...ok2(), conflict: true }))
      assert(a.stage === 'data_incomplete' && b.stage === 'data_conflict', `结果：${a.stage} / ${b.stage}`)
      return '条件都满足时，仅名称 → 数据待补全，有冲突 → 数据冲突'
    })
    await step(results, '漏斗', '快照只在结果变化时追加；新信号自动从归档恢复', async () => {
      await db.query(`UPDATE wr_projects SET first_seen_at = now() - interval '40 days', last_signal_at = now() - interval '40 days' WHERE id = $1`, [p2])
      await pipeline.evaluateProjects([p2])
      await pipeline.evaluateProjects([p2])
      const r1 = await db.one('SELECT stage FROM wr_projects WHERE id = $1', [p2])
      const s1 = await db.one('SELECT count(*)::int c FROM wr_screening_snapshots WHERE project_id = $1', [p2])
      assert(r1.stage === 'archived', `40 天无信号应归档，实际 ${r1.stage}`)
      assert(s1.c === 1, `连续评估两次应只有 1 条快照，实际 ${s1.c}`)
      const ev = await D.insertEvent({ type: 'fundraising', externalId: `${tag}-react`, title: 'selftest' })
      await D.linkEvent(ev, { projectId: p2, method: 'name', confidence: 'low' })
      await D.refreshSignals()
      const ch = await pipeline.evaluateProjects([p2])
      const r2 = await db.one('SELECT stage, reactivated_at, stage_reason FROM wr_projects WHERE id = $1', [p2])
      const s2 = await db.one('SELECT count(*)::int c FROM wr_screening_snapshots WHERE project_id = $1', [p2])
      assert(r2.stage !== 'archived' && r2.reactivated_at && /重新激活/.test(r2.stage_reason || ''), `没有自动恢复：${r2.stage}`)
      assert(ch.changed[0]?.reactivated === true && s2.c === 2, `快照 ${s2.c} 条`)
      const f2 = await db.one('SELECT screening_facts->>\'would_be_stage\' AS w FROM wr_projects WHERE id = $1', [p2])
      assert(!['dormant', 'archived'].includes(r2.stage) && !f2.w, `恢复后仍是 ${r2.stage}，原阶段记录 ${f2.w}`)
      const st = await db.one('SELECT snapshot_type, data_as_of FROM wr_screening_snapshots WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [p2])
      assert(st.snapshot_type === 'historical_runtime' && st.data_as_of, `快照类型 ${st.snapshot_type}，数据截至 ${st.data_as_of}`)
      return `归档（31+ 天）→ 新融资事件 → 恢复为自动阶段「${r2.stage}」（已标记重新激活），快照 1 → 2 条，类型「当时运行」`
    })
    await step(results, '漏斗', '人工确认链：来源记为人工、留痕备注和阶段历史、立即重新评估', async () => {
      await pipeline.confirmChains(p2, ['base'], '自检')
      const r = await db.one('SELECT chains, chain_source, chain_status FROM wr_projects WHERE id = $1', [p2])
      const n = await db.one(`SELECT count(*)::int c FROM wr_notes WHERE project_id = $1 AND body LIKE '人工确认所属链%'`, [p2])
      const h = await db.one(`SELECT count(*)::int c FROM wr_stage_history WHERE project_id = $1 AND source = 'manual' AND reason LIKE '人工确认所属链%'`, [p2])
      const sn = await db.one('SELECT snapshot_type FROM wr_screening_snapshots WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [p2])
      assert(r.chain_source === 'manual' && r.chain_status === 'core_confirmed' && (r.chains || []).includes('base'), `结果：${JSON.stringify(r)}`)
      assert(n.c === 1, '没有写备注')
      assert(h.c === 1, '没有写阶段历史')
      assert(sn.snapshot_type === 'manual_recalculate', `人工确认后的快照类型应为人工重算，实际 ${sn.snapshot_type}`)
      let threw = false
      try { await pipeline.confirmChains(p2, []) } catch { threw = true }
      assert(threw, '空链列表应被拒绝')
      return '链 = base，来源人工确认，状态核心链已确认，已写备注和阶段历史，快照记为「人工重算」'
    })
    await step(results, '漏斗', 'M3 版本隔离：重新评估只追加新快照，旧快照原样保留', async () => {
      const before = await db.query('SELECT id, facts_hash, rule_version, snapshot_type, md5(facts::text) AS fh FROM wr_screening_snapshots WHERE project_id = $1 ORDER BY id', [p2])
      assert(before.length >= 2, `快照不足：${before.length}`)
      await db.query(`UPDATE wr_projects SET tge_status = 'post' WHERE id = $1`, [p2])
      await pipeline.evaluateProjects([p2])
      const after = await db.query('SELECT id, facts_hash, rule_version, snapshot_type, md5(facts::text) AS fh FROM wr_screening_snapshots WHERE project_id = $1 ORDER BY id', [p2])
      for (const b of before) {
        const a = after.find((x) => x.id === b.id)
        assert(a && a.facts_hash === b.facts_hash && a.fh === b.fh && a.rule_version === b.rule_version && a.snapshot_type === b.snapshot_type, `旧快照 #${b.id} 被改动`)
      }
      assert(after.length === before.length + 1, `应追加 1 条，实际 ${after.length - before.length}`)
      const f = { screening_rule_version: 'm2.3', x: 1 }
      assert(pipeline.factsHash('screening', f) !== pipeline.factsHash('screening', { ...f, screening_rule_version: 'm3' }), '规则版本不同但哈希相同')
      return `${before.length} 条旧快照未变，追加 1 条；规则版本不同会生成新快照`
    })
    await step(results, '漏斗', '身份补全候选：只选从没搜过的仅名称项目；搜过且无新信号的不再查', async () => {
      const p3 = (await db.one(`INSERT INTO wr_projects (name, discovery_source) VALUES ($1, 'selftest_tmp') RETURNING id`, [`WR自检补全${tag}`])).id
      tmp.push(p3)
      let c = await D.identityCandidates(100000, 7)
      assert(c.some((r) => r.id === p3), '未搜过的仅名称项目不在候选中')
      await db.query(`UPDATE wr_projects SET surf_searched_at = now() WHERE id = $1`, [p3])
      c = await D.identityCandidates(100000, 7)
      assert(!c.some((r) => r.id === p3), '刚搜过的项目仍在候选中')
      assert(require('./identity').PROJECT_REF_TABLES.includes('wr_screening_snapshots'), '合并项目时没有迁移初筛快照')
      return '未搜过 → 候选；搜过后移出；合并时快照随项目迁移'
    })
    await step(results, '漏斗', '人工设定的阶段不会被自动评估改掉', async () => {
      await pipeline.setStageManual(p1, 'watch', '自检：人工设为重点观察')
      await pipeline.evaluateProjects([p1])
      const r = await db.one('SELECT stage, stage_source, coverage_level FROM wr_projects WHERE id = $1', [p1])
      assert(r.stage === 'watch' && r.stage_source === 'manual', `被改成了 ${r.stage}`)
      assert(r.coverage_level === 'deep_research', '预算层级没有随阶段更新')
      const h = await db.one('SELECT count(*)::int c FROM wr_stage_history WHERE project_id = $1', [p1])
      assert(h.c >= 1, '没有记录阶段历史')
      await pipeline.restoreAuto(p1)
      const r2 = await db.one('SELECT stage_source FROM wr_projects WHERE id = $1', [p1])
      assert(r2.stage_source === 'auto', '恢复自动失败')
      return '评估后仍为「重点观察」，预算层级同步为深度尽调；恢复自动后交还规则'
    })
  } finally {
    if (tmp.length) {
      await db.query('DELETE FROM wr_stage_history WHERE project_id = ANY($1)', [tmp])
      await db.query('DELETE FROM wr_screening_snapshots WHERE project_id = ANY($1)', [tmp])
      await db.query('DELETE FROM wr_notes WHERE project_id = ANY($1)', [tmp])
      await db.query('DELETE FROM wr_events WHERE external_id LIKE $1 OR project_id = ANY($2)', [`${tag}%`, tmp])
      await db.query('DELETE FROM wr_alerts WHERE project_id = ANY($1)', [tmp])
      await db.query('DELETE FROM wr_project_relations WHERE project_a = ANY($1) OR project_b = ANY($1)', [tmp])
      await db.query('DELETE FROM wr_projects WHERE id = ANY($1)', [tmp])
    } else {
      await db.query('DELETE FROM wr_events WHERE external_id LIKE $1', [`${tag}%`])
    }
  }
}

async function deployTests(results) {
  const { listProjects } = require('./projectQuery')
  await step(results, '部署', '项目池筛选：链 / 来源 / 关键词及组合都能正确查询', async () => {
    const combos = [
      {}, { chain: 'ethereum' }, { source: 'airdrop' }, { q: 'uni' }, { chain: 'ethereum', stage: 'screening' },
      { q: 'uni', source: 'fundraising' }, { q: 'a', chain: 'solana', source: 'airdrop', identity: 'confirmed', stage: 'screening', sort: 'credits' },
      { q: "%_'\\" }, { q: 'zz-no-such-project-zz' }, { limit: 5, offset: 5 },
    ]
    for (const c of combos) {
      const r = await listProjects({ ...c, limit: c.limit ?? 200 })
      assert(Array.isArray(r.data), `${JSON.stringify(c)} 没有返回数组`)
      const all = await listProjects({ ...c, limit: 200, offset: 0 })
      if (!c.limit) assert(all.total === all.data.length || all.total > 200, `${JSON.stringify(c)} 的总数 ${all.total} 与结果 ${all.data.length} 不一致`)
      if (!c.stage) {
        const sum = Object.values(r.stage_counts).reduce((a, b) => a + b, 0)
        assert(sum === r.total, `${JSON.stringify(c)} 的阶段计数合计 ${sum} ≠ 总数 ${r.total}`)
      }
    }
    // 阶段计数不受阶段筛选影响
    const a = await listProjects({ chain: 'ethereum' })
    const b = await listProjects({ chain: 'ethereum', stage: 'screening' })
    assert(JSON.stringify(a.stage_counts) === JSON.stringify(b.stage_counts), '阶段计数受到了阶段筛选影响')
    assert(b.total === (a.stage_counts.screening || 0), '阶段筛选后的总数与阶段计数不一致')
    const page = await listProjects({ limit: 5, offset: 5 })
    assert(page.data.length <= 5, '分页数量错误')
    return `${combos.length} 种组合全部正常；无结果返回空数组；阶段计数与总数一致`
  })
  await step(results, '部署', '未登录访问业务接口被拒绝', async () => {
    const port = process.env.BACKEND_PORT || 3001
    const base = `http://127.0.0.1:${port}/api`
    const codes = {}
    for (const path of ['projects', 'radar/overview', 'system/overview']) {
      const r = await fetch(`${base}/${path}`)
      codes[path] = r.status
    }
    const bad = Object.entries(codes).filter(([, c]) => c !== 401)
    assert(bad.length === 0, `以下接口未受保护：${bad.map(([p, c]) => `${p}=${c}`).join(', ')}`)
    const forged = await fetch(`${base}/projects`, { headers: { authorization: 'Bearer eyJleHAiOjk5OTk5OTk5OTk5OTl9.forged' } })
    assert(forged.status === 401, '伪造令牌被接受')
    const health = await fetch(`${base}/health`)
    assert(health.status === 200, '健康检查不可用')
    return '3 个业务接口均返回 401；伪造令牌被拒绝；健康检查正常'
  })
  await step(results, '部署', '两个环境不会同时采集 / 重复自动采集', async () => {
    // 全部使用 dryRun：即使锁失效也不会真的发起采集
    const { runDiscovery, LOCK_KEY } = require('./collect/discovery')
    const before = await db.one(`SELECT count(*)::int c FROM wr_api_usage WHERE task LIKE 'discovery_%'`)
    const l1 = await db.lock(`${LOCK_KEY}-selftest`, 60)
    const l2 = await db.lock(`${LOCK_KEY}-selftest`, 60)
    assert(l1 && !l2, '同一把锁被重复获取')
    await l1.release()
    const l3 = await db.lock(`${LOCK_KEY}-selftest`, 60)
    assert(l3, '释放后无法再次获取')
    await l3.release()
    const held = await db.lock(LOCK_KEY, 60)
    assert(held, '无法获取采集锁（可能真的有采集在运行，稍后重试）')
    let r1
    try { r1 = await runDiscovery({ trigger: 'auto', dryRun: true }) } finally { await held.release() }
    assert(r1?.skipped && /锁/.test(r1.reason), `锁被占用时没有跳过：${JSON.stringify(r1)}`)
    const fake = await db.one(
      `INSERT INTO wr_job_runs (job, trigger, status, instance, finished_at) VALUES ('discovery','auto','ok','selftest', now()) RETURNING id`)
    let r2
    try { r2 = await runDiscovery({ trigger: 'auto', dryRun: true }) } finally { await db.query('DELETE FROM wr_job_runs WHERE id = $1', [fake.id]) }
    assert(r2?.skipped && /今天/.test(r2.reason), `当天已有自动采集时没有跳过：${JSON.stringify(r2)}`)
    const after = await db.one(`SELECT count(*)::int c FROM wr_api_usage WHERE task LIKE 'discovery_%'`)
    assert(after.c === before.c, '跳过时仍然发起了采集请求')
    return '锁不能重复获取、释放后可再取；锁被占用 → 跳过；当天已有自动采集 → 跳过；均未产生请求'
  })
}

module.exports = { runSelftest }
