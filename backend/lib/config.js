// 配置与密钥读取。密钥只来自环境变量或 backend/.env.local（已加入 .gitignore），不写进代码。
const fs = require('node:fs')
const path = require('node:path')

let loaded = false
function loadLocalEnv() {
  if (loaded) return
  loaded = true
  for (const file of ['.env.local', '.env']) {
    const p = path.join(__dirname, '..', file)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const eq = s.indexOf('=')
      if (eq < 0) continue
      const k = s.slice(0, eq).trim()
      const v = s.slice(eq + 1).trim()
      if (!process.env[k]) process.env[k] = v
    }
  }
}

function getSecret(name) {
  loadLocalEnv()
  return process.env[name] || ''
}

// 返回所有已配置的密钥值（用于自检：确保它们没有出现在日志/存档里）
function secretValues() {
  loadLocalEnv()
  return ['HELIUS_API_KEY', 'SURF_API_KEY', 'GITHUB_TOKEN']
    .map((k) => process.env[k])
    .filter((v) => v && v.length >= 12)
}

module.exports = { getSecret, secretValues }
