-- M3 评分框架（口径待 1–2 天真实数据后再锁定）
-- 设计原则：质量分与 TGE 分分离；每次评分留下带版本的历史快照，便于口径变更后回看。

ALTER TABLE wr_projects
  ADD COLUMN IF NOT EXISTS quality_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS tge_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS action_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS score_grade text,
  ADD COLUMN IF NOT EXISTS score_confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS score_version text,
  ADD COLUMN IF NOT EXISTS scored_at timestamptz;

CREATE INDEX IF NOT EXISTS wr_projects_quality_idx
  ON wr_projects (quality_score DESC NULLS LAST) WHERE merged_into IS NULL;

CREATE TABLE IF NOT EXISTS wr_scores (
  id bigserial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES wr_projects(id) ON DELETE CASCADE,
  score_version text NOT NULL,
  scoring_rule_version text NOT NULL,
  quality_score numeric(5,2),
  tge_score numeric(5,2),
  action_score numeric(5,2),
  grade text,
  confidence numeric(4,3),
  coverage numeric(4,3),
  freshness_days integer,
  recommendation text,
  dims jsonb NOT NULL DEFAULT '{}'::jsonb,
  tge_dims jsonb NOT NULL DEFAULT '{}'::jsonb,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts_hash text,
  config_hash text,
  snapshot_type text NOT NULL DEFAULT 'historical_runtime',
  data_as_of timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wr_scores_project_idx
  ON wr_scores (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS wr_scores_version_idx
  ON wr_scores (score_version, created_at DESC);

-- 评分口径（权重 / 阈值 / 折扣）单独存一份，便于对比「锁定前」与「锁定后」的差异
INSERT INTO wr_registry (kind, key, value)
VALUES ('setting', 'score_config', '{}'::jsonb)
ON CONFLICT (kind, key) DO NOTHING;
