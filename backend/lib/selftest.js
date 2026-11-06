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

  // ───── 评分（M3 框架）─────
  await scoringTests(results)

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
    await step(results, '漏斗', '休眠 / 归档阈值：有实体信息 21 天休眠、45 天归档，初筛不自动休眠', async () => {
      const ago = (d) => new Date(Date.now() - d * 86400000).toISOString()
      const a = pipeline.decideStage(base({ lastSignalAt: ago(20) }))
      const b = pipeline.decideStage(base({ lastSignalAt: ago(22) }))
      const c = pipeline.decideStage(base({ lastSignalAt: ago(46) }))
      const d = pipeline.decideStage(base({ ...ok2(), lastSignalAt: ago(60) }))
      assert(a.stage === 'discovered' && b.stage === 'dormant' && c.stage === 'archived' && d.stage === 'screening',
        `结果：${a.stage} / ${b.stage} / ${c.stage} / ${d.stage}`)
      assert(b.facts.would_be_stage === 'discovered' && b.facts.idle_days === 22, '休眠时没有记录原阶段或天数')
      assert(pipeline.DEFAULT_PIPELINE_CONFIG.dormant_days === 21 && pipeline.DEFAULT_PIPELINE_CONFIG.archive_days === 45, '默认天数不是 21 / 45')
      return '20 天 → 发现；22 天 → 休眠；46 天 → 归档；初筛 60 天仍为初筛'
    })
    await step(results, '漏斗', '仅名称线索：无第二证据 14 天直接归档（只归档不删除），有融资则按正式项目处理', async () => {
      const ago = (d) => new Date(Date.now() - d * 86400000).toISOString()
      const a = pipeline.decideStage(base({ identity: 'name_only', lead: true, lastSignalAt: ago(13) }))
      const b = pipeline.decideStage(base({ identity: 'name_only', lead: true, lastSignalAt: ago(15) }))
      const c = pipeline.decideStage(base({ identity: 'name_only', lead: false, lastSignalAt: ago(15) }))
      assert(a.stage === 'data_incomplete' && a.facts.lead === true, `13 天线索引线应为数据待补全：${a.stage}`)
      assert(b.stage === 'archived' && /线索/.test(b.reason), `15 天线索引线应归档：${b.stage}`)
      assert(c.stage !== 'archived', `有第二证据的仅名称项目不应按线索归档：${c.stage}`)
      assert(pipeline.DEFAULT_PIPELINE_CONFIG.lead_archive_days === 14, '线索归档天数不是 14')
      return `线索 13 天 → ${a.stage}；15 天 → 归档；有融资的仅名称项目 → ${c.stage}`
    })
    await step(results, '漏斗', '上市证据三级：市场推断已上市（市值 ≥ 5000 万 + 代币符号）移出早期池，但仍不是确认上市', async () => {
      const ago = (d) => new Date(Date.now() - d * 86400000).toISOString()
      const a = pipeline.decideStage(base({ ...ok2(), symbol: 'META', project: { name: 'X', tge_status: null }, metrics: { market_cap_usd: 60e6, fdv_usd: 60e6 }, lastSignalAt: ago(1) }))
      const b = pipeline.decideStage(base({ ...ok2(), symbol: 'SMALL', project: { name: 'Y', tge_status: null }, metrics: { market_cap_usd: 20e6 } }))
      const c = pipeline.decideStage(base({ ...ok2(), symbol: null, project: { name: 'Z', tge_status: null }, metrics: { market_cap_usd: 80e6 } }))
      assert(a.stage === 'listed_watch' && a.facts.listing_evidence_level === 'market_inferred' && a.facts.maturity === 'listed',
        `市值 6000 万 + 符号：${a.stage} / ${a.facts.listing_evidence_level}`)
      assert(b.stage === 'screening' && b.facts.listing_evidence_level === 'inferred', `市值 2000 万：${b.stage} / ${b.facts.listing_evidence_level}`)
      assert(c.stage !== 'listed_watch' && c.facts.listing_evidence_level === 'inferred', `无代币符号：${c.stage} / ${c.facts.listing_evidence_level}`)
      assert(pipeline.listingLevelOf({ tgeStatus: 'post' }) === 'confirmed', 'TGE 已完成应为确认上市')
      return `6000 万 + 符号 → 市场推断已上市（${a.stage}）；2000 万 → ${b.stage}；无符号 → ${c.stage}`
    })
    await step(results, '漏斗', '身份只有名称 → 数据待补全；有冲突 → 数据冲突', async () => {
      const a = pipeline.decideStage(base({ ...ok2(), identity: 'name_only' }))
      const b = pipeline.decideStage(base({ ...ok2(), conflict: true }))
      assert(a.stage === 'data_incomplete' && b.stage === 'data_conflict', `结果：${a.stage} / ${b.stage}`)
      return '条件都满足时，仅名称 → 数据待补全，有冲突 → 数据冲突'
    })
    await step(results, '漏斗', '快照只在结果变化时追加；新信号自动从归档恢复', async () => {
      await db.query(`UPDATE wr_projects SET first_seen_at = now() - interval '46 days', last_signal_at = now() - interval '46 days' WHERE id = $1`, [p2])
      await pipeline.evaluateProjects([p2])
      await pipeline.evaluateProjects([p2])
      const r1 = await db.one('SELECT stage FROM wr_projects WHERE id = $1', [p2])
      const s1 = await db.one('SELECT count(*)::int c FROM wr_screening_snapshots WHERE project_id = $1', [p2])
      assert(r1.stage === 'archived', `46 天无信号应归档，实际 ${r1.stage}`)
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
      return `归档（46 天）→ 新融资事件 → 恢复为自动阶段「${r2.stage}」（已标记重新激活），快照 1 → 2 条，类型「当时运行」`
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

// ───── M3 评分框架验收：结构与不变量为主，权重 / 阈值等真实数据稳定后再锁定 ─────
function scoreFixture(over = {}) {
  const now = new Date().toISOString()
  return {
    project: { id: 0, name: '自检样例', stage: 'pending_verify', tge_status: 'pre', ...(over.project || {}) },
    identity: 'confirmed',
    hard: { credible_funding: true, verifiable_product: true, token_plan: false, onchain_activity: null, ecosystem_integration: null },
    completeness: { name: true, domain: true, twitter: true, surf_id: true, contract: true, chains: true, tge: true, funding: true, token_data: false },
    metrics: { twitter_followers: 20000 },
    metricAt: { twitter_followers: now, tvl_usd: now },
    detailFetchedAt: now,
    chainStatus: 'core_confirmed',
    chains: ['ethereum'],
    chainSource: 'surf_detail',
    listingLevel: 'none',
    dataAsOf: now,
    lead: false,
    conflict: false,
    productLevel: 'high',
    origins: {
      credible_funding: new Set(['surf_fundraising']),
      verifiable_product: new Set(['onchain']),
      multi_source: new Set(['multi']),
    },
    ...over,
  }
}

const scoreExtras = (over = {}) => ({
  fundingRounds: 2, maxFundingUsd: 8e6, publicSale: false, listingEvents: 0, tgeStatus: 'pre',
  recentEvents: 3, lastEventAt: new Date().toISOString(), lastFundingAt: new Date().toISOString(),
  airdropTask: false, hasContract: true, ...over,
})

async function scoringTests(results) {
  const scoring = require('./scoring')

  await step(results, '评分', '评分口径可配置且权重合计为 1（当前为草案，未锁定）', async () => {
    const cfg = await scoring.loadScoreConfig()
    const q = Object.values(cfg.quality_weights).reduce((a, b) => a + Number(b), 0)
    const t = Object.values(cfg.tge_weights).reduce((a, b) => a + Number(b), 0)
    assert(Math.abs(q - 1) <= 0.001, `质量分权重合计 ${q}`)
    assert(Math.abs(t - 1) <= 0.001, `TGE 分权重合计 ${t}`)
    assert(cfg.locked === false, '当前不应锁定口径')
    assert(cfg.thresholds.deep_research == null && cfg.thresholds.watch == null, '阈值应保持未锁定')
    return `${scoring.SCORE_VERSION}，质量分 / TGE 分权重均合计 1，阈值未锁定`
  })

  await step(results, '评分', '同一事实两次评分结果一致，分数都在 0–100', async () => {
    const cfg = await scoring.loadScoreConfig()
    const a = scoring.scoreFacts(scoreFixture(), scoreExtras(), cfg)
    const b = scoring.scoreFacts(scoreFixture(), scoreExtras(), cfg)
    assert(JSON.stringify(a) === JSON.stringify(b), '同样输入得到了不同结果')
    for (const k of ['quality_score', 'tge_score', 'action_score']) {
      assert(a[k] == null || (a[k] >= 0 && a[k] <= 100), `${k} 越界：${a[k]}`)
    }
    assert(a.confidence >= 0 && a.confidence <= 1, `置信度越界：${a.confidence}`)
    assert(a.coverage > 0 && a.coverage <= 1, `覆盖率越界：${a.coverage}`)
    assert(a.dims && Object.keys(a.dims).length === 6, '维度不完整')
    return `质量 ${a.quality_score} / TGE ${a.tge_score} / 行动 ${a.action_score}，置信度 ${a.confidence}`
  })

  await step(results, '评分', '质量分与 TGE 分分离：已 TGE 的项目没有 TGE 分', async () => {
    const cfg = await scoring.loadScoreConfig()
    const pre = scoring.scoreFacts(scoreFixture({ project: { id: 0, name: 'A', stage: 'pending_verify', tge_status: 'pre' } }), scoreExtras(), cfg)
    const post = scoring.scoreFacts(scoreFixture({ project: { id: 0, name: 'B', stage: 'listed_watch', tge_status: 'post' }, listingLevel: 'confirmed' }), scoreExtras(), cfg)
    assert(pre.tge_score != null, 'TGE 前项目应有 TGE 分')
    assert(post.tge_score === null, `已 TGE 项目不应有 TGE 分：${post.tge_score}`)
    assert(post.quality_score > 0, '已 TGE 项目仍应有质量分（用于回测）')
    return `TGE 前 ${pre.tge_score} 分；已 TGE → TGE 分为 null，质量分 ${post.quality_score} 保留`
  })

  await step(results, '评分', '市场推断上市会打折；仅名称线索不给行动建议', async () => {
    const cfg = await scoring.loadScoreConfig()
    const confirmed = scoring.scoreFacts(scoreFixture({ listingLevel: 'confirmed' }), scoreExtras(), cfg)
    const inferred = scoring.scoreFacts(scoreFixture({ listingLevel: 'market_inferred' }), scoreExtras(), cfg)
    assert(inferred.quality_score < confirmed.quality_score, 'market_inferred 没有打折')
    assert(inferred.flags.some((f) => f.code === 'market_inferred'), '缺少 market_inferred 红旗')
    const lead = scoring.scoreFacts(scoreFixture({ lead: true, identity: 'name_only', productLevel: null }), scoreExtras({ hasContract: false }), cfg)
    assert(lead.action_score === null, '线索不应有行动分')
    assert(lead.recommendation === 'lead_only', `线索建议应为 lead_only，实际 ${lead.recommendation}`)
    assert(lead.flags.some((f) => f.code === 'lead'), '缺少线索红旗')
    return `market_inferred ${inferred.quality_score} < 已确认 ${confirmed.quality_score}；线索行动分 null`
  })

  await step(results, '评分', '覆盖率折扣只作用于行动分；Robinhood 行动分受上限约束', async () => {
    const cfg = await scoring.loadScoreConfig()
    const eth = scoring.scoreFacts(scoreFixture(), scoreExtras(), cfg)
    const sol = scoring.scoreFacts(scoreFixture({ chains: ['solana'] }), scoreExtras(), cfg)
    assert(eth.quality_score === sol.quality_score, '链覆盖折扣不应改变质量分')
    assert(sol.action_score < eth.action_score, 'SOL 行动分应低于同等 ETH 项目')
    const rh = scoring.scoreFacts(scoreFixture({
      chains: ['robinhood'], listingLevel: 'none',
      metrics: { twitter_followers: 2e6, tvl_usd: 500e6 },
      completeness: { name: true, domain: true, twitter: true, surf_id: true, contract: true, chains: true, tge: true, funding: true, token_data: true },
      origins: {
        credible_funding: new Set(['surf_fundraising']), verifiable_product: new Set(['onchain']),
        multi_source: new Set(['multi']), social_traction: new Set(['surf_project']),
      },
    }), scoreExtras({ maxFundingUsd: 80e6, fundingRounds: 3, listingEvents: 2 }), cfg)
    assert(rh.quality_score >= 80, `Robinhood 样例质量分不够高（${rh.quality_score}），无法验证上限`)
    assert(rh.action_score != null && rh.action_score <= cfg.robinhood_action_cap, `Robinhood 行动分 ${rh.action_score} 超过上限 ${cfg.robinhood_action_cap}`)
    assert(rh.flags.some((f) => f.code === 'robinhood_review'), '缺少 Robinhood 人工复核红旗')
    return `ETH 行动 ${eth.action_score} > SOL ${sol.action_score}；Robinhood ${rh.action_score} ≤ ${cfg.robinhood_action_cap}`
  })

  await step(results, '评分', '置信度随身份 / 证据 / 时效变化', async () => {
    const cfg = await scoring.loadScoreConfig()
    const good = scoring.scoreFacts(scoreFixture(), scoreExtras(), cfg)
    const nameOnly = scoring.scoreFacts(scoreFixture({ identity: 'name_only', origins: {} }), scoreExtras(), cfg)
    const oldAt = new Date(Date.now() - 120 * 86400000).toISOString()
    const stale = scoring.scoreFacts(
      scoreFixture({ dataAsOf: oldAt, metricAt: { twitter_followers: oldAt, tvl_usd: oldAt }, detailFetchedAt: oldAt }),
      scoreExtras({ lastFundingAt: oldAt, lastEventAt: oldAt }), cfg)
    assert(nameOnly.confidence < good.confidence, '仅名称线索的置信度没有降低')
    assert(stale.confidence < good.confidence, '过期数据置信度没有降低')
    assert(stale.flags.some((f) => f.code === 'stale_data'), '缺少数据过期红旗')
    return `完整 ${good.confidence} > 仅名称 ${nameOnly.confidence}；过期 ${stale.confidence}`
  })

  await step(results, '评分', '评分历史：结果不变不追加，口径变化生成新版本快照', async () => {
    const target = await db.one(
      `SELECT id, name FROM wr_projects WHERE merged_into IS NULL AND score_version IS NOT NULL ORDER BY quality_score DESC NULLS LAST LIMIT 1`)
    assert(target, '没有可评分的真实项目')
    const r1 = await scoring.scoreProjects([target.id], { snapshotType: 'manual_recalculate' })
    const r2 = await scoring.scoreProjects([target.id], { snapshotType: 'manual_recalculate' })
    assert(r2.snapshots === 0, `结果未变仍追加了 ${r2.snapshots} 条快照`)
    const row = await db.one(
      `SELECT score_version, scoring_rule_version, quality_score::float q, dims, flags, reasons, config_hash, snapshot_type
       FROM wr_scores WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [target.id])
    const version = scoring.versionOf(await scoring.loadScoreConfig())
    assert(row.score_version === version && row.scoring_rule_version === scoring.SCORING_RULE_VERSION, `版本号未写入（期望 ${version}，实际 ${row.score_version}）`)
    assert(row.dims && Object.keys(row.dims).length === 6, '维度没有落库')
    assert(Array.isArray(row.flags) && Array.isArray(row.reasons) && row.config_hash, '红旗 / 理由 / 口径指纹缺失')
    assert(row.snapshot_type === 'manual_recalculate', `快照类型错误：${row.snapshot_type}`)
    return `${target.name}：第二次评分 0 条新快照；版本 ${row.score_version}，口径指纹 ${row.config_hash}`
  })

  await step(results, '评分', '数据覆盖率与链折扣分开：覆盖率看六个维度，链折扣只作用于行动分', async () => {
    const cfg = await scoring.loadScoreConfig()
    const full = scoring.scoreFacts(scoreFixture(), scoreExtras(), cfg)
    const sparse = scoring.scoreFacts(scoreFixture({
      chains: [], chainStatus: 'none', productLevel: null, origins: {},
      metrics: {}, metricAt: {},
    }), scoreExtras({ fundingRounds: 0, maxFundingUsd: 0, recentEvents: 0, lastFundingAt: null, hasContract: false }), cfg)
    assert(full.data_coverage === 1, `完整样例的数据覆盖应为 1，实际 ${full.data_coverage}`)
    assert(sparse.data_coverage < 0.5, `缺少数据的样例覆盖率仍偏高：${sparse.data_coverage}`)
    const sol = scoring.scoreFacts(scoreFixture({ chains: ['solana'] }), scoreExtras(), cfg)
    assert(sol.data_coverage === full.data_coverage, '换链不应改变数据覆盖率')
    assert(sol.chain_factor === 0.9 && full.chain_factor === 1, `链折扣错误：SOL ${sol.chain_factor} / ETH ${full.chain_factor}`)
    return `完整 ${full.data_coverage}、稀疏 ${sparse.data_coverage}；SOL 链系数 ${sol.chain_factor}、ETH ${full.chain_factor}`
  })

  await step(results, '评分', '代币计划不算融资覆盖：只有 token_plan 时融资维度仍是缺数据', async () => {
    const cfg = await scoring.loadScoreConfig()
    const withPlan = scoreFixture({
      project: { id: 0, name: '只有代币计划', stage: 'pending_verify', tge_status: 'pre' },
      hard: { credible_funding: false, verifiable_product: true, token_plan: true, onchain_activity: null, ecosystem_integration: null },
    })
    const noFunding = scoreExtras({ fundingRounds: 0, maxFundingUsd: 0, publicSale: false })
    const r = scoring.scoreFacts(withPlan, noFunding, cfg)
    assert(Math.abs(r.data_coverage - 0.83) < 0.011, `只有 token_plan 时覆盖率应缺融资维度（5/6），实际 ${r.data_coverage}`)
    const sale = scoring.scoreFacts(withPlan, { ...noFunding, publicSale: true }, cfg)
    assert(sale.data_coverage === 1, `有公募记录时融资维度应有数据，实际覆盖率 ${sale.data_coverage}`)
    const funded = scoring.scoreFacts(withPlan, scoreExtras(), cfg)
    assert(funded.data_coverage === 1, `有融资轮次时融资维度应有数据，实际覆盖率 ${funded.data_coverage}`)
    assert(r.dims.funding === 20, `无融资时融资维度分数应为基础值，实际 ${r.dims.funding}`)
    return `只有 token_plan → 覆盖 ${r.data_coverage}（缺融资）；有公募 / 融资 → 覆盖 1.0`
  })

  await step(results, '评分', '数据时效取关键维度最老的数据，不被新事件拉高', async () => {
    const cfg = await scoring.loadScoreConfig()
    const old = new Date(Date.now() - 120 * 86400000).toISOString()
    const r = scoring.scoreFacts(scoreFixture({ metricAt: { twitter_followers: old, tvl_usd: new Date().toISOString() } }), scoreExtras(), cfg)
    assert(r.freshness_days >= 100, `社区数据 120 天前，时效却算成 ${r.freshness_days} 天`)
    return `关键维度最老 120 天 → 数据时效 ${r.freshness_days} 天`
  })

  await step(results, '评分', '锁定后不能直接改口径；解锁需原因并让版本 +1', async () => {
    const base = { ...scoring.DEFAULT_SCORE_CONFIG, thresholds: { deep_research: 75, watch: 60 }, locked: true, revision: 1 }
    let blocked = null
    try { scoring.applyConfigChange(base, { ...base, min_confidence: 0.5 }) } catch (e) { blocked = e.message }
    assert(blocked && /已锁定/.test(blocked) && /最低置信度/.test(blocked), `锁定后仍可改口径：${blocked}`)
    let unlocked = null
    try { unlocked = scoring.applyUnlock(base, '自检：观察期需要调整') } catch (e) { unlocked = null }
    assert(unlocked && unlocked.locked === false && unlocked.revision === 2, '解锁失败或版本没有 +1')
    assert(unlocked.unlock_log?.length === 1 && /观察期/.test(unlocked.unlock_log[0].reason), '解锁原因没有留痕')
    const { next } = scoring.applyConfigChange(unlocked, { ...unlocked, min_confidence: 0.5 })
    assert(next.min_confidence === 0.5, '解锁后仍不能改口径')
    let lockBlocked = null
    try {
      scoring.applyConfigChange({ ...scoring.DEFAULT_SCORE_CONFIG }, { ...scoring.DEFAULT_SCORE_CONFIG, locked: true })
    } catch (e) { lockBlocked = e.message }
    assert(lockBlocked && /阈值/.test(lockBlocked), '没有阈值也能锁定')
    return '锁定时拒绝修改并以「最低置信度」提示；解锁留痕、版本 1→2；无阈值不能锁定'
  })

  await step(results, '评分', '三个真实项目验收框架（ETH / SOL / Robinhood 各一个）', async () => {
    const pick = async (chain) => db.one(
      `SELECT id, name, chains, stage, quality_score::float q, tge_score::float t, action_score::float a, score_grade g
       FROM wr_projects WHERE merged_into IS NULL AND chains ? $1 AND score_version IS NOT NULL
       ORDER BY (stage IN ('screening','pending_verify','data_incomplete','discovered')) DESC,
                quality_score DESC NULLS LAST LIMIT 1`, [chain])
    const picks = []
    for (const chain of ['ethereum', 'solana', 'robinhood']) {
      const p = await pick(chain)
      if (!p) { picks.push(`${chain}：暂无项目（等待采集）`); continue }
      for (const k of ['q', 't', 'a']) assert(p[k] == null || (p[k] >= 0 && p[k] <= 100), `${p.name} 的 ${k} 越界`)
      assert(p.g, `${p.name} 没有等级`)
      picks.push(`${p.name}（${chain}）质量 ${p.q} / TGE ${p.t ?? '—'} / 行动 ${p.a ?? '—'}，${p.g}`)
    }
    const rows = await db.one(`SELECT count(*)::int c FROM wr_scores`)
    assert(rows.c > 0, '评分历史表为空')
    return `${picks.join('；')}。口径未锁定，阈值待真实数据观察 1–2 天后确定`
  })
}

module.exports = { runSelftest, _internal: { scoringTests } }
