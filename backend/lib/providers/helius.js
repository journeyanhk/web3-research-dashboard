// Helius（Solana）适配器：JSON-RPC。API Key 只在请求时拼接，不进入日志和存档。
const { fetchJson, HttpError } = require('../http')
const { getSecret } = require('../config')

const DAS_METHODS = new Set([
  'getAsset', 'getAssetBatch', 'getAssetProof', 'getAssetProofBatch', 'getAssetsByOwner', 'getAssetsByAuthority',
  'getAssetsByCreator', 'getAssetsByGroup', 'searchAssets', 'getSignaturesForAsset', 'getTokenAccounts', 'getNftEditions',
])
const TEN_CREDIT = new Set(['getProgramAccounts', 'getTransactionsForAddress'])

function costOf(method, table = {}) {
  if (DAS_METHODS.has(method)) return table.das ?? 10
  if (TEN_CREDIT.has(method)) return table[method] ?? 10
  return table.rpc ?? 1
}

module.exports = {
  id: 'helius',
  costOf,
  minIntervalMs: (endpoint) => (DAS_METHODS.has(endpoint) ? 550 : 110), // DAS 2 次/秒，RPC 10 次/秒
  bucket: (endpoint) => (DAS_METHODS.has(endpoint) ? 'helius_das' : 'helius_rpc'),
  estimate: ({ endpoint }) => costOf(endpoint),
  async execute({ endpoint, params, costTable }) {
    const key = getSecret('HELIUS_API_KEY')
    if (!key) throw new HttpError('未配置 HELIUS_API_KEY', 401)
    const { status, body } = await fetchJson(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'wr', method: endpoint, params }),
    })
    if (body?.error) {
      const code = body.error.code
      const err = new HttpError(`RPC ${code}: ${body.error.message}`, code === 429 || code === -32429 ? 429 : 400, body)
      throw err
    }
    return { status, body, credits: costOf(endpoint, costTable) }
  },
}
