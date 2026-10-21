// npm run check：静态检查（不调用任何外部接口、不花点数）
// 1) 所有后端 JS 语法检查  2) 迁移文件编号连续且不重复  3) cron.json 格式与 handler 存在
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const SKIP = new Set(['node_modules', 'scripts'])
let failed = 0
const ok = (m) => console.log(`✓ ${m}`)
const fail = (m) => { failed++; console.error(`✕ ${m}`) }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out) } else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name))
  }
  return out
}

const files = walk(ROOT)
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) { fail(`语法错误 ${path.relative(ROOT, f)}\n${e.stderr}`) }
}
ok(`语法检查 ${files.length} 个文件`)

const migs = fs.readdirSync(path.join(ROOT, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
const nums = migs.map((f) => Number(f.split('_')[0]))
const gap = nums.some((n, i) => n !== i + 1)
if (gap) fail(`迁移编号不连续：${migs.join(', ')}`); else ok(`迁移文件 ${migs.length} 个，编号连续`)

try {
  const cron = JSON.parse(fs.readFileSync(path.join(ROOT, 'cron.json'), 'utf8'))
  for (const t of cron) {
    if (!fs.existsSync(path.join(ROOT, t.handler))) fail(`cron 任务 ${t.id} 的 handler 不存在：${t.handler}`)
    else if (typeof require(path.join(ROOT, t.handler)).handler !== 'function') fail(`cron 任务 ${t.id} 未导出 handler`)
  }
  ok(`cron.json ${cron.length} 个任务`)
} catch (e) { fail(`cron.json 解析失败：${e.message}`) }

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1) }
console.log('\n全部通过')
