-- M2.1：阶段历史操作者与规则版本；采集运行实例标识

ALTER TABLE wr_stage_history ADD COLUMN IF NOT EXISTS operator text;       -- system / self（单人使用；团队部署时可复用）
ALTER TABLE wr_stage_history ADD COLUMN IF NOT EXISTS rule_version text;   -- 自动评估所用的规则版本
UPDATE wr_stage_history SET operator = CASE WHEN source = 'manual' THEN 'self' ELSE 'system' END WHERE operator IS NULL;
UPDATE wr_stage_history SET rule_version = 'pipeline-v1' WHERE rule_version IS NULL AND source = 'auto';

-- 运行实例：区分预览环境与发布环境（两者共用同一数据库）
ALTER TABLE wr_job_runs ADD COLUMN IF NOT EXISTS instance text;
