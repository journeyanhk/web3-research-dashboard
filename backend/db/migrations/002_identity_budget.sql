-- M0.1：身份冲突与合并、预算估算/实际分离、项目级复核状态

-- 1) 身份标识：强标识（surf_id / contract）全局唯一；弱标识（domain / twitter）允许多个项目共用，
--    命中弱标识只进入冲突队列，不自动合并
DROP INDEX IF EXISTS wr_project_ids_type_value_uq;
ALTER TABLE wr_project_ids DROP CONSTRAINT IF EXISTS wr_project_ids_id_type_id_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS wr_project_ids_strong_uq ON wr_project_ids (id_type, id_value)
  WHERE id_type IN ('surf_id', 'contract');
CREATE UNIQUE INDEX IF NOT EXISTS wr_project_ids_project_type_value_uq ON wr_project_ids (project_id, id_type, id_value);
CREATE INDEX IF NOT EXISTS wr_project_ids_lookup_idx ON wr_project_ids (id_type, id_value);

-- 2) 项目：合并去向 + Robinhood Chain 等的项目级复核状态
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS merged_into integer;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'not_required';
  -- not_required / pending / passed / rejected / expired
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS review_expires_at timestamptz;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS review_reason text;

-- 3) 项目关系：疑似重复队列 / 确认相同（含合并记录）/ 确认不同
CREATE TABLE IF NOT EXISTS wr_project_relations (
  id            serial PRIMARY KEY,
  project_a     integer NOT NULL,   -- 较小的项目 ID
  project_b     integer NOT NULL,   -- 较大的项目 ID
  status        text NOT NULL,      -- possible_duplicate / confirmed_same / confirmed_different
  reason        text,
  confidence    text,               -- high / low
  evidence      jsonb,
  source_project_id integer,        -- 合并时：被并入的项目
  target_project_id integer,        -- 合并时：保留的项目
  merged_at     timestamptz,
  decided_by    text,               -- auto / user
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (project_a, project_b)
);
CREATE INDEX IF NOT EXISTS wr_project_relations_status_idx ON wr_project_relations (status);

-- 4) 记账：预估与实际分开
ALTER TABLE wr_api_usage RENAME COLUMN credits TO actual_credits;
ALTER TABLE wr_api_usage ADD COLUMN IF NOT EXISTS estimated_credits numeric;
CREATE INDEX IF NOT EXISTS wr_api_usage_endpoint_idx ON wr_api_usage (provider, endpoint, created_at);
