-- M2.3：初筛口径收紧 —— 成熟度、链状态、独立来源、休眠/归档、筛选结果快照

-- 成熟度：early / pre_tge / listed / mature / chain_infrastructure / unknown
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS maturity_status text;
-- 链状态：core_confirmed / other_confirmed / core_inferred（待核实链）/ none
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS chain_status text;
-- 链信息来源：manual > surf_detail > airdrop_task > inferred
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS chain_source text;
-- Surf 项目标签（赛道，如 Layer1 / DEX & AMM）
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS tags jsonb;
-- 最近一次有效信号（新闻不算）：用于休眠 / 归档 / 重新激活
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS last_signal_at timestamptz;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS reactivated_at timestamptz;
-- 本项目当前事实所用的筛选规则版本（如 m2.3）
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS screening_rule_version text;

CREATE INDEX IF NOT EXISTS wr_projects_maturity_idx ON wr_projects (maturity_status);
CREATE INDEX IF NOT EXISTS wr_projects_chain_status_idx ON wr_projects (chain_status);

-- 筛选结果快照：项目的阶段 / 满足与缺失条件 / 证据 发生变化时追加一条，只增不改。
-- 用途：M3 评分开发期间改规则时，历史筛选结果仍可追溯、可复盘。
CREATE TABLE IF NOT EXISTS wr_screening_snapshots (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL,
  rule_version text NOT NULL,
  stage text,
  stage_reason text,
  facts jsonb,
  facts_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wr_screening_snapshots_project_idx ON wr_screening_snapshots (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wr_screening_snapshots_version_idx ON wr_screening_snapshots (rule_version);

