-- M1.1：名称歧义处理、关联证据、项目详情 404 重试

-- 事件关联证据（命中的名称、候选项目、选中的项目与理由）
ALTER TABLE wr_events ADD COLUMN IF NOT EXISTS link_evidence jsonb;
CREATE INDEX IF NOT EXISTS wr_events_link_method_idx ON wr_events (link_method) WHERE link_method = 'name_ambiguous';

-- Surf 查不到详情的项目：记录时间，30 天后（或出现新的融资 / TGE / 上币事件时）允许重试一次
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS detail_not_found_at timestamptz;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS detail_retry_after timestamptz;
UPDATE wr_projects SET detail_not_found_at = detail_fetched_at, detail_retry_after = detail_fetched_at + interval '30 days'
WHERE flags ? 'detail_not_found' AND detail_not_found_at IS NULL;
