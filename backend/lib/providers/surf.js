// Surf 数据接口适配器
require('../config') // 确保 SURF_API_KEY 已从密钥文件注入（生产环境）
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
  // 调用前预估：已知接口查成本表（可在注册表中调整），未知接口按保守值；实际按返回的 credits_used 记账
  estimate: ({ endpoint, costTable }) => Number(costTable?.[endpoint] ?? costTable?._default ?? 2),
  async execute({ endpoint, params, method }) {
    try {
      const body = method === 'POST' ? await dataApi.post(endpoint, params) : await dataApi.get(endpoint, params)
      return { status: 200, body, credits: Number(body?.meta?.credits_used ?? 0) }
    } catch (e) {
      throw toHttpError(e)
    }
  },
}
