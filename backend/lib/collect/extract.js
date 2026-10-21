// 从事件标题 / 摘要中提取结构化信息（规则可在评审后调整）

// 关注的 6 条链：关键词 → 链 ID。Base 是常见英文单词，只在明确语境下识别
const CHAIN_PATTERNS = [
  ['ethereum', /\b(ethereum|以太坊|eth mainnet|erc-?20)\b|以太坊/i],
  ['bsc', /\b(bnb chain|bnb smart chain|bsc|binance smart chain)\b|币安智能链/i],
  ['base', /\b(on|onto|to|via) base\b|\bbase (chain|network|mainnet|l2|ecosystem)\b|在\s*base\s*(上|链)|base\s*(链|生态|网络)/i],
  ['arbitrum', /\barbitrum\b/i],
  ['solana', /\b(solana|sol chain)\b|索拉纳/i],
  ['robinhood', /\brobinhood chain\b|robinhood\s*链/i],
]

function detectChains(...texts) {
  const t = texts.filter(Boolean).join(' \n ')
  return CHAIN_PATTERNS.filter(([, re]) => re.test(t)).map(([id]) => id)
}

// 传统金融 / 非项目类融资：仍保存，但标记为噪声，不建项目
const TRADFI_PATTERNS = /优先股|普通股|股票发行|增发.*股|纳斯达克|nasdaq|nyse|preferred stock|common stock|share offering|\betf\b/i

function exclusionReason(title, summary) {
  if (TRADFI_PATTERNS.test(`${title || ''} ${summary || ''}`)) return '传统金融（股票/ETF 等）'
  return null
}

const PUBLIC_SALE_PATTERNS = /公开销售|公募|代币销售|\bido\b|\bico\b|\bieo\b|public sale|token sale|presale|预售|认购/i
const isPublicSale = (title, summary) => PUBLIC_SALE_PATTERNS.test(`${title || ''} ${summary || ''}`)

// 标题开头的项目名：取第一个中文字符 / 中文动词之前的部分（标题格式一般为「X 完成… / X 将… / X的…」）
const LEAD_STOP = /\s+(完成|获得|宣布|将|已|正在|加入|启动|开启|开放|推出|筹集|融资|获|与|和|在|于|发布|计划|即将|重新)|的|\s+(raises?|secures?|completes?|closes?|launches?|announces?|joins?|opens?|receives?|lands?|gets?|reschedules?|is|has|to)\b/i

function extractLeadName(title) {
  if (!title) return null
  let t = String(title).trim().replace(/^[「『“"【\[]+/, '')
  const m = LEAD_STOP.exec(t)
  if (m && m.index > 0) t = t.slice(0, m.index)
  t = t.replace(/[，,：:。.!！?？]+$/, '').trim()
  // 去掉末尾的中文（如「GAIB的」已被截断；这里处理残余）
  t = t.replace(/[一-鿿].*$/, '').trim()
  if (t.length < 2 || t.length > 40) return null
  if (/^\$?\d/.test(t)) return null
  return t
}

// 金额：$1M / $630 million / 1500 万美元 / 2.5 亿美元 / $134,400
function parseUsdAmount(text) {
  if (!text) return null
  const s = String(text)
  let m = /(\d+(?:\.\d+)?)\s*(亿|万)\s*美元/.exec(s)
  if (m) return Number(m[1]) * (m[2] === '亿' ? 1e8 : 1e4)
  m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand|bn|b|m|k)?\b/i.exec(s)
  if (m) {
    const n = Number(m[1].replace(/,/g, ''))
    const u = (m[2] || '').toLowerCase()
    const mul = u.startsWith('b') ? 1e9 : u === 'm' || u === 'million' ? 1e6 : u === 'k' || u === 'thousand' ? 1e3 : 1
    return n * mul
  }
  return null
}

// 融资轮次
function parseRound(text) {
  const m = /(种子|天使|pre-?seed|seed|pre-?a|series\s*[a-d]|a\+?|b|c|d|战略|strategic)\s*(融资)?\s*(轮|round)/i.exec(String(text || ''))
  if (!m) return null
  const k = m[1].toLowerCase().replace(/^series\s*/, '')
  const map = { 种子: 'Seed', seed: 'Seed', 'pre-seed': 'Pre-Seed', preseed: 'Pre-Seed', 天使: 'Angel', 战略: 'Strategic', strategic: 'Strategic' }
  return map[k] || `${k.toUpperCase()} 轮`
}

// 领投方：「由 X 领投」/ "led by X"
function parseLead(text) {
  const s = String(text || '')
  let m = /由\s*([^，,。、]{2,40}?)\s*领投/.exec(s)
  if (m) return m[1].trim()
  m = /led by ([A-Z][\w .&-]{1,40}?)(?:[,.]| with| and|$)/.exec(s)
  return m ? m[1].trim() : null
}

module.exports = { detectChains, exclusionReason, isPublicSale, extractLeadName, parseUsdAmount, parseRound, parseLead }
