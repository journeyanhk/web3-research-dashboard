-- M2：项目池与状态流转

-- 项目阶段由谁决定：auto（规则自动评估）/ manual（人工设定后自动规则不再改动）
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS stage_source text NOT NULL DEFAULT 'auto';
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS stage_reason text;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz;
-- 评估结果快照：初筛硬条件 / 加分条件 / 缺失项
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS screening_facts jsonb;
-- 可筛选的派生字段（每次评估刷新）
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS identity_status text;        -- confirmed / partial / name_only
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS source_types jsonb;          -- ["airdrop","fundraising",...]
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS signal_label text;           -- 只有空投信号 / 空投 + 融资 / 多源确认 …
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS completeness numeric;        -- 资料完整度 0–1
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;
CREATE INDEX IF NOT EXISTS wr_projects_stage_idx ON wr_projects (stage) WHERE merged_into IS NULL;

-- 阶段变更历史
CREATE TABLE IF NOT EXISTS wr_stage_history (
  id          serial PRIMARY KEY,
  project_id  integer NOT NULL,
  from_stage  text,
  to_stage    text NOT NULL,
  source      text NOT NULL,          -- auto / manual
  reason      text,
  facts       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wr_stage_history_project_idx ON wr_stage_history (project_id, created_at DESC);

-- 研究备注
CREATE TABLE IF NOT EXISTS wr_notes (
  id          serial PRIMARY KEY,
  project_id  integer NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wr_notes_project_idx ON wr_notes (project_id, created_at DESC);
