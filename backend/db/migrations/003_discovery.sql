-- M1：全局发现（事件、采集运行记录、项目身份状态字段）

-- 事件：融资 / 公募 / 空投 / 新闻 / 上币 / TGE 状态
CREATE TABLE IF NOT EXISTS wr_events (
  id               serial PRIMARY KEY,
  project_id       integer,                 -- 关联的项目（可为空：未能确认身份）
  event_type       text NOT NULL,           -- fundraising / public_sale / airdrop / news / listing / tge
  external_id      text NOT NULL,           -- 数据源中的唯一 ID（无 ID 时用字段组合）
  provider         text NOT NULL DEFAULT 'surf',
  endpoint         text,
  title            text,
  summary          text,
  url              text,
  source_name      text,
  importance       integer,
  chains           jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate_name   text,                    -- 从标题/字段中提取的项目名
  candidate_symbol text,
  link_method      text,                    -- surf_id / name_search / name / symbol / none
  link_confidence  text,                    -- high / medium / low / none
  excluded_reason  text,                    -- 被判定为噪声的原因（仍保存，便于统计噪声率）
  event_at         timestamptz,
  published_at     timestamptz,
  data             jsonb,                   -- 解析出的结构化字段（金额、状态、交易所…）
  raw_id           integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, external_id)
);
CREATE INDEX IF NOT EXISTS wr_events_type_time_idx ON wr_events (event_type, event_at DESC);
CREATE INDEX IF NOT EXISTS wr_events_project_idx ON wr_events (project_id, event_at DESC);

-- 采集任务运行记录
CREATE TABLE IF NOT EXISTS wr_job_runs (
  id           serial PRIMARY KEY,
  job          text NOT NULL,
  trigger      text NOT NULL,              -- auto / manual
  status       text NOT NULL,              -- running / ok / partial / error
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS wr_job_runs_job_idx ON wr_job_runs (job, started_at DESC);

-- 项目：身份确认与 TGE 基础字段
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS detail_fetched_at timestamptz;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS tge_status text;            -- pre / upcoming / post
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS tge_exchanges jsonb;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS last_event_at timestamptz;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS logo_url text;
CREATE INDEX IF NOT EXISTS wr_projects_first_seen_idx ON wr_projects (first_seen_at DESC) WHERE merged_into IS NULL;
