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
  lib/identity.js       项目身份确认、去重与合并（见下方规则）
  lib/metrics.js        指标写入（只追加，记录主源 / 备用源）
  lib/selftest.js       验收自检
  lib/collect/          M1 全局发现：extract.js（标题解析）、discovery.js（采集 + 身份确认）
  jobs/discovery.js     定时任务入口（cron.json：每日 01:17 UTC / 北京 09:17）
  routes/system.js      /api/system/*（概览、调用记录、配置、自检）
  routes/projects.js    /api/projects/*（身份冲突队列；M2 扩展项目池）
  routes/radar.js       /api/radar/*（雷达概览、采集质量、手动采集）
frontend/src/
  App.tsx               导航
  pages/RadarPage.tsx   项目雷达
  pages/SystemPage.tsx  数据与点数
```

## 命令

```bash
cd backend
npm run check   # 静态检查：语法、迁移编号、cron 配置（不花点数）
npm test        # check + 验收自检（真实数据，约 Surf 1–2 点、Helius 10 credits）
```

## M1 采集规则（试跑期）

| 数据 | 每次 | 建项目条件 | 关联方式 |
|---|---|---|---|
| 融资 / 公募 | ≤50 条，近 3 天 | 重要度 ≥3、能从标题识别项目名、非股票/ETF | 同名项目 → Surf 名称完全一致 → 仅名称建档 |
| 空投 | ≤50 条 | 有 Surf ID / 有融资额 / 社交分 ≥50 | Surf ID；否则仅名称（不再查 Surf） |
| 上币（含盘前合约） | ≤100 条 | 不建项目 | 代币符号唯一时关联已有项目 |
| 新闻 | ≤100 条 | 不建项目 | Surf 项目 ID |
| 项目详情 | ≤10 个 | — | 补官网、X、合约、链、TGE 状态、代币数据 |

每次运行最多按名称查 Surf 15 次；同一项目查找冷却 7 天。
Surf 查不到详情（404）的项目：30 天内不再请求；期间出现新的融资 / 公募 / 上币 / TGE 事件时允许提前重试一次。

### 名称关联规则（M1.1）

| 同名项目 | 处理 | link_method / 置信度 |
|---|---|---|
| 0 个 | 查 Surf（名称完全一致才用）→ 否则仅名称建档 | name_search 中 / name 低 |
| 1 个 | 关联，但不算身份确认 | name / 低 |
| 多个，其中唯一 1 个有强身份 | 关联到它，记录选择理由 | name_disambiguated / 中 |
| 多个，无法区分 | **不关联**，进入「名称歧义队列」由人工选择 | name_ambiguous / 无 |

每条关联都在 `wr_events.link_evidence` 记录命中名称、候选项目、选中项目与理由；
融资事件在 `data.extraction` 记录原始提取名、标准化名与解析规则版本（extract-v1）。
所有规模参数在注册表 `setting/discovery_config` 中，可调整。雷达只展示发现，不展示评分。

## 部署前必须完成

- `/api/radar/*`、`/api/projects/*`、`/api/system/*` 增加访问认证（当前仅在 Studio 内部单人使用）

## 环境变量

见 `backend/.env.example`。本地开发放在 `backend/.env.local`（已被 .gitignore 排除）。

## 点数规则

- 页面只读数据库，浏览不消耗点数；所有外部调用都经过 `lib/providers` 记账。
- Surf：月预算（默认 1800，硬上限，手动请求也不能突破）、自动任务日上限（月预算 ÷ 30 × 70%）。
- 单项目**全程累计**上限 `stage_total_caps`：发现 3 → 初筛 8 → 深度尽调 30 → TGE 观察 45（升级阶段不额外叠加）。
- 调用记录分开保存 `estimated_credits`（调用前按成本表预估）与 `actual_credits`（按返回实际记账）；
  Surf 成本表在注册表 `provider/surf.cost_table`，未知接口按 2 点保守预估。
- Helius：70% 提示 / 85% 暂停非必要任务 / 95% 仅手动 / 100% 停止。

## 项目身份规则

| 情况 | 处理 |
|---|---|
| Surf 项目 ID 相同 / 同链合约地址相同 / 官网域名 + X 账号同时相同 | 高置信度，自动合并 |
| 只有官网域名相同 / 只有 X 账号相同 | 低置信度，进入「身份冲突队列」，由人工判断 |
| 已人工确认不同 | 不再提示；若强标识又同时指向两者，发出告警 |

合并在一个事务内完成：迁移身份标识、指标、告警、调用记录与点数消耗，记录写入 `wr_project_relations`。
后续新增引用 `project_id` 的表，需要加入 `identity.js` 的 `PROJECT_REF_TABLES`。

## 里程碑

- [x] M0 基础底座（数据表、链能力矩阵、数据源记账、预算限额、原始存档、去重、自检）
- [x] M0.1 Review 修正（身份合并与冲突队列、预算累计语义、预估/实际成本、自检补强）
- [x] M1 全局发现 + 身份确认 + 雷达首页（试跑中）
- [x] M1.1 名称歧义修正 + 数据质量边界测试
- [ ] M2 项目池与状态流转
- [ ] M3 全自动评分
- [ ] M4 TGE / 解锁 + SOL 外部数据 + Robinhood Chain
- [ ] M5 研究工作台
- [ ] M6 告警中心、调度、效果指标
