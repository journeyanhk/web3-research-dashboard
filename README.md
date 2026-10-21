# Web3 早期项目投研平台

发现 → 去重 → 初筛 → 评分 → TGE / 解锁 → 研究 → 复盘。单人使用，重点覆盖 6 条链：

| 层级 | 链 | 说明 |
|---|---|---|
| A 完整自动 | Ethereum、BNB Chain、Base、Arbitrum | Surf 持仓 / DEX / 链上 SQL / TVL 全覆盖 |
| B 部分自动 | Solana | Surf + Helius + DexScreener / GeckoTerminal |
| C 事件驱动 | Robinhood Chain | 仅链上 SQL；可交易推荐需人工复核 |
| 暂停 | Arc | 满足数据门槛后再启用 |

## 目录

```
backend/
  db/migrations/*.sql   表结构（启动时自动执行未应用的迁移，所有表 wr_ 前缀）
  lib/db.js             数据库唯一出入口（DATABASE_URL）
  lib/config.js         密钥读取（环境变量 / backend/.env.local，不进仓库）
  lib/registry.js       链能力矩阵、数据源、系统配置（默认值，之后以数据库为准）
  lib/budget.js         Surf 三道点数限额 + Helius 额度保护线
  lib/providers/        统一调用管道：缓存 → 预算 → 限速 → 退避重试 → 原始存档 → 记账；备用源切换
  lib/identity.js       项目身份确认与去重（Surf ID / 域名 / X 账号 / 合约）
  lib/metrics.js        指标写入（只追加，记录主源 / 备用源）
  lib/selftest.js       验收自检
  routes/system.js      /api/system/*
frontend/src/
  App.tsx               导航
  pages/SystemPage.tsx  数据与点数
```

## 环境变量

见 `backend/.env.example`。本地开发放在 `backend/.env.local`（已被 .gitignore 排除）。

## 点数规则

- 页面只读数据库，浏览不消耗点数；所有外部调用都经过 `lib/providers` 记账。
- Surf：月预算（默认 1800）、自动任务日上限（月预算 ÷ 30 × 70%）、单项目阶段累计上限。
- Helius：70% 提示 / 85% 暂停非必要任务 / 95% 仅手动 / 100% 停止。

## 里程碑

- [x] M0 基础底座（数据表、链能力矩阵、数据源记账、预算限额、原始存档、去重、自检）
- [ ] M1 全局发现 + 身份确认 + 雷达首页
- [ ] M2 项目池与状态流转
- [ ] M3 全自动评分
- [ ] M4 TGE / 解锁 + SOL 外部数据 + Robinhood Chain
- [ ] M5 研究工作台
- [ ] M6 告警中心、调度、效果指标
