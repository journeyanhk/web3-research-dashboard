// Surf 数据接口适配器
const { dataApi } = require('@surf-ai/sdk/server')
const { HttpError } = require('../http')

function toHttpError(e) {
  const m = /API error (\d{3})/.exec(e.message || '')
  const err = new HttpError(e.message, m ? Number(m[1]) : undefined)
  if (!m) err.network = true
  return err
}

module.exports = {
  id: 'surf',
  minIntervalMs: () => 150,
  estimate: () => 2, // 调用前的保守估计；实际按返回的 credits_used 记账
  async execute({ endpoint, params, method }) {
    try {
      const body = method === 'POST' ? await dataApi.post(endpoint, params) : await dataApi.get(endpoint, params)
      return { status: 200, body, credits: Number(body?.meta?.credits_used ?? 0) }
    } catch (e) {
      throw toHttpError(e)
    }
  },
}
