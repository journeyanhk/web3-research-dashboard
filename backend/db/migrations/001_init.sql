-- M0 基础表（本项目所有表统一 wr_ 前缀）

-- 注册表：链能力矩阵(kind=chain)、数据源(kind=provider)、系统配置(kind=setting)
CREATE TABLE IF NOT EXISTS wr_registry (
  kind        text NOT NULL,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);

-- 每次外部调用的记账（每个数据源单独统计）
CREATE TABLE IF NOT EXISTS wr_api_usage (
  id            serial PRIMARY KEY,
  provider      text NOT NULL,
  endpoint      text NOT NULL,
  params        jsonb,
  trigger       text NOT NULL,          -- auto / manual / selftest
  task          text,
  priority      text,                   -- essential / normal / low
  project_id    integer,
  status        text NOT NULL,          -- ok / error / cached / blocked
  http_status   integer,
  credits       numeric NOT NULL DEFAULT 0,
  duration_ms   integer,
  attempts      integer NOT NULL DEFAULT 1,
  rate_limited  integer NOT NULL DEFAULT 0,
  error         text,
  raw_id        integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wr_api_usage_provider_created_idx ON wr_api_usage (provider, created_at);
CREATE INDEX IF NOT EXISTS wr_api_usage_project_idx ON wr_api_usage (project_id);

-- 原始响应存档（成功和失败都保存，解析结果另存）
CREATE TABLE IF NOT EXISTS wr_raw_responses (
  id                serial PRIMARY KEY,
  provider          text NOT NULL,
  endpoint          text NOT NULL,
  params_hash       text NOT NULL,
  params            jsonb,
  status            text NOT NULL,      -- ok / error
  http_status       integer,
  body              jsonb,
  error             text,
  response_version  text,
  fetched_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wr_raw_lookup_idx ON wr_raw_responses (provider, endpoint, params_hash, fetched_at);

-- 项目
CREATE TABLE IF NOT EXISTS wr_projects (
  id                serial PRIMARY KEY,
  surf_project_id   text,
  name              text NOT NULL,
  symbol            text,
  website_domain    text,
  twitter_handle    text,
  category          text,
  chains            jsonb NOT NULL DEFAULT '[]'::jsonb,
  primary_chain     text,
  chain_priority    text,               -- core / opportunity / unsupported
  stage             text NOT NULL DEFAULT 'discovered',
  coverage_level    text NOT NULL DEFAULT 'discovery',  -- discovery / screening / deep_research / tge_watch
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  discovery_source  text,
  credits_spent     numeric NOT NULL DEFAULT 0,
  flags             jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 项目身份标识：同一标识只能属于一个项目（用于去重）
CREATE TABLE IF NOT EXISTS wr_project_ids (
  id          serial PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES wr_projects(id) ON DELETE CASCADE,
  id_type     text NOT NULL,            -- surf_id / domain / twitter / contract
  id_value    text NOT NULL,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id_type, id_value)
);
CREATE INDEX IF NOT EXISTS wr_project_ids_project_idx ON wr_project_ids (project_id);

-- 指标（只追加不覆盖，记录主源/备用源）
CREATE TABLE IF NOT EXISTS wr_metrics (
  id               serial PRIMARY KEY,
  project_id       integer,
  chain            text,
  subject          text,
  metric_name      text NOT NULL,
  value            numeric,
  value_json       jsonb,
  unit             text,
  source           text NOT NULL,
  primary_source   text,
  fallback_used    boolean NOT NULL DEFAULT false,
  fallback_reason  text,
  observed_at      timestamptz,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  confidence       numeric,
  raw_id           integer
);
CREATE INDEX IF NOT EXISTS wr_metrics_project_name_idx ON wr_metrics (project_id, metric_name, fetched_at);

-- 告警与数据问题（M6 告警中心直接复用）
CREATE TABLE IF NOT EXISTS wr_alerts (
  id           serial PRIMARY KEY,
  project_id   integer,
  category     text NOT NULL,           -- data / budget / opportunity / risk / task
  alert_type   text NOT NULL,
  severity     text NOT NULL DEFAULT 'info',  -- info / warn / critical
  title        text,
  detail       jsonb,
  status       text NOT NULL DEFAULT 'open',  -- open / resolved / dismissed
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS wr_alerts_status_idx ON wr_alerts (status, created_at);
CREATE INDEX IF NOT EXISTS wr_alerts_dedupe_idx ON wr_alerts (dedupe_key) WHERE status = 'open';
