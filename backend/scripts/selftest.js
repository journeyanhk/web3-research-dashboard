// npm test：运行验收自检（真实数据，约消耗 Surf 1–2 点、Helius 10 credits）
const { runSelftest } = require('../lib/selftest')

runSelftest().then((r) => {
  for (const x of r.results) console.log(`${x.ok === true ? '✓' : x.ok === false ? '✕' : '·'} [${x.group}] ${x.name}：${x.detail}`)
  console.log(`\n通过 ${r.passed} 项，失败 ${r.failed} 项`)
  process.exit(r.failed ? 1 : 0)
}).catch((e) => { console.error(e); process.exit(1) })
