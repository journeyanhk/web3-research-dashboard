// 数据库唯一出入口：独立 PostgreSQL（DATABASE_URL）。
// 首次查询前自动执行 db/migrations 下未应用的迁移。迁移到私有环境只需更换 DATABASE_URL。
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const { getSecret } = require('./config')

let pool = null
function getPool() {
  if (pool) return pool
  const raw = getSecret('DATABASE_URL')
  if (!raw) throw new Error('未配置 DATABASE_URL')
  // 显式使用 verify-full（与当前 pg 的行为一致），避免弃用警告
  const connectionString = raw.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full')
  pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 })
  pool.on('error', (e) => console.error('[db] 连接池错误：', e.message))
  return pool
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations')
let migrated = null

async function migrate() {
  const p = getPool()
  await p.query(`CREATE TABLE IF NOT EXISTS wr_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await p.query('SELECT name FROM wr_migrations')).rows.map((r) => r.name))
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (done.has(f)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
    const client = await p.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO wr_migrations (name) VALUES ($1)', [f])
      await client.query('COMMIT')
      console.log(`[db] 已应用迁移 ${f}`)
    } catch (e) {
      await client.query('ROLLBACK')
      throw new Error(`迁移 ${f} 失败：${e.message}`)
    } finally {
      client.release()
    }
  }
}

function ready() {
  if (!migrated) migrated = migrate().catch((e) => { migrated = null; throw e })
  return migrated
}

async function query(sql, params = []) {
  await ready()
  const res = await getPool().query(sql, params)
  return res.rows || []
}

async function one(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}

// 事务：fn(q) 内的 q(sql, params) 在同一连接上执行，出错整体回滚
async function tx(fn) {
  await ready()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const q = async (sql, params = []) => (await client.query(sql, params)).rows || []
    const result = await fn(q)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// 租约锁（基于表，单条原子语句）：拿到返回 { release }，被占用返回 null（不等待）。
// 不用 pg advisory lock：Neon 的连接池（-pooler，事务级复用）下会话锁不可靠。
// 租约到期自动失效，进程崩溃也不会永久卡住。
async function lock(name, ttlSec = 1800) {
  await ready()
  const holder = require('node:crypto').randomUUID()
  const r = await getPool().query(
    `INSERT INTO wr_registry (kind, key, value, updated_at)
     VALUES ('lock', $1, jsonb_build_object('holder', $2::text, 'expires_at', now() + ($3 || ' seconds')::interval), now())
     ON CONFLICT (kind, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE (wr_registry.value->>'expires_at')::timestamptz < now()
     RETURNING key`,
    [String(name), holder, String(ttlSec)],
  )
  if (!r.rows.length) return null
  return {
    holder,
    release: async () => {
      await getPool().query(`DELETE FROM wr_registry WHERE kind = 'lock' AND key = $1 AND value->>'holder' = $2`, [String(name), holder])
    },
  }
}

module.exports = { query, one, ready, tx, lock }
