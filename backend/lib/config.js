// 配置与密钥读取（密钥不写进代码、不进 Git）
// 优先级：环境变量 > backend/.env.local / .env（开发）> backend/secrets/runtime.json（随 Surf 发布包部署）
// 说明：Surf 发布时会剔除所有 .env* 文件，所以生产环境依赖 secrets/runtime.json。
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
let loaded = false

function setIfMissing(k, v) {
  if (v != null && v !== '' && !process.env[k]) process.env[k] = String(v)
}

function loadLocalEnv() {
  if (loaded) return
  loaded = true
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const eq = s.indexOf('=')
      if (eq < 0) continue
      setIfMissing(s.slice(0, eq).trim(), s.slice(eq + 1).trim())
    }
  }
  const rt = path.join(ROOT, 'secrets', 'runtime.json')
  if (fs.existsSync(rt)) {
    try {
      const obj = JSON.parse(fs.readFileSync(rt, 'utf8'))
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'SURF_API_KEY_FALLBACK') setIfMissing('SURF_API_KEY', v)
        else setIfMissing(k, v)
      }
    } catch (e) {
      console.error('[config] secrets/runtime.json 解析失败：', e.message)
    }
  }
}

// 模块加载时立即注入，保证 Surf SDK 等直接读取 process.env 的代码也能拿到
loadLocalEnv()

function getSecret(name) {
  loadLocalEnv()
  return process.env[name] || ''
}

// 已配置的密钥值（用于自检：确保它们没有出现在代码、日志、存档里）
function secretValues() {
  loadLocalEnv()
  return ['HELIUS_API_KEY', 'SURF_API_KEY', 'GITHUB_TOKEN', 'DATABASE_URL', 'ADMIN_PASSWORD', 'AUTH_SECRET']
    .map((k) => process.env[k])
    .filter((v) => v && v.length >= 12)
}

// 各项密钥的来源（不返回值，只说明从哪里读到的），用于自检展示
function secretSources() {
  return Object.fromEntries(['SURF_API_KEY', 'HELIUS_API_KEY', 'DATABASE_URL', 'ADMIN_PASSWORD', 'AUTH_SECRET']
    .map((k) => [k, process.env[k] ? 'configured' : 'missing']))
}

module.exports = { getSecret, secretValues, secretSources, loadLocalEnv }
