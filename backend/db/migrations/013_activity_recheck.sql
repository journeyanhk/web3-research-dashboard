-- M3.2：休眠前主动回查 + 正式项目详情定期刷新
-- activity_checked_at：最近一次按项目回查 Surf 项目事件的时间（14 天冷却）
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS activity_checked_at timestamptz;
COMMENT ON COLUMN wr_projects.activity_checked_at IS '最近一次休眠前主动回查（Surf 项目事件）的时间';
CREATE INDEX IF NOT EXISTS wr_events_endpoint_idx ON wr_events (endpoint) WHERE endpoint = 'search/events';
