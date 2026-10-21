// 免费 REST 数据源（DexScreener / GeckoTerminal / DefiLlama）
const { fetchJson } = require('../http')

const BASES = {
  dexscreener: 'https://api.dexscreener.com',
  geckoterminal: 'https://api.geckoterminal.com/api/v2',
  defillama: 'https://api.llama.fi',
}
const INTERVAL = { dexscreener: 250, geckoterminal: 2100, defillama: 300 }

function make(id) {
  return {
    id,
    minIntervalMs: () => INTERVAL[id],
    estimate: () => 0,
    async execute({ endpoint, params }) {
      const url = new URL(BASES[id] + endpoint)
      for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v))
      const { status, body } = await fetchJson(url.toString(), { headers: { accept: 'application/json' } })
      return { status, body, credits: 0 }
    },
  }
}

module.exports = { dexscreener: make('dexscreener'), geckoterminal: make('geckoterminal'), defillama: make('defillama') }
