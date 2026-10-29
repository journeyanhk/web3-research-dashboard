-- M2.3 Review 修正（不花点数）
-- 1) 空投任务涉及的链与项目部署链分开：campaign_chains 只用于展示 / 活动分析，不参与链状态与核心链初筛
-- 2) 上市证据分级：listing_evidence_level（confirmed / inferred / none）
-- 3) 筛选快照区分类型：historical_runtime（当时运行结果）/ migration_backfill（迁移时重算）/ manual_recalculate（人工触发重算）

ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS campaign_chains jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS listing_evidence_level text;
CREATE INDEX IF NOT EXISTS wr_projects_listing_evidence_idx ON wr_projects (listing_evidence_level);

ALTER TABLE wr_screening_snapshots ADD COLUMN IF NOT EXISTS snapshot_type text NOT NULL DEFAULT 'historical_runtime';
ALTER TABLE wr_screening_snapshots ADD COLUMN IF NOT EXISTS data_as_of timestamptz;
CREATE INDEX IF NOT EXISTS wr_screening_snapshots_type_idx ON wr_screening_snapshots (snapshot_type);

-- 回填：活动链 = 已关联空投事件里的链（并集）
UPDATE wr_projects p SET campaign_chains = c.chains
FROM (SELECT e.project_id, jsonb_agg(DISTINCT ch) AS chains
      FROM wr_events e, jsonb_array_elements_text(COALESCE(e.chains,'[]'::jsonb)) ch
      WHERE e.event_type = 'airdrop' AND e.project_id IS NOT NULL AND e.excluded_reason IS NULL
      GROUP BY e.project_id) c
WHERE p.id = c.project_id;

-- 回填：Surf 详情里没有 overview.chains、只有合约所在链的项目，来源改记为「合约所在链」
UPDATE wr_projects p SET chain_source = 'contract_chain'
WHERE chain_source = 'surf_detail'
  AND EXISTS (SELECT 1 FROM wr_project_ids i WHERE i.project_id = p.id AND i.id_type = 'contract')
  AND NOT EXISTS (SELECT 1 FROM wr_raw_responses r WHERE r.endpoint = 'project/detail' AND r.status = 'ok'
                    AND r.params->>'id' = p.surf_project_id
                    AND jsonb_array_length(COALESCE(r.body->'data'->'overview'->'chains','[]'::jsonb)) > 0);

-- 现有快照都是 M2.3 上线时用当前数据重算出来的，不是项目当时真实可见的结果
UPDATE wr_screening_snapshots SET snapshot_type = 'migration_backfill', data_as_of = COALESCE(data_as_of, created_at)
WHERE snapshot_type = 'historical_runtime';

-- 旧规则（pipeline-v1 / v2）当时的自动判断：从阶段历史导入为「当时运行结果」快照，只导入一次
INSERT INTO wr_screening_snapshots (project_id, rule_version, stage, stage_reason, facts, facts_hash, created_at, snapshot_type, data_as_of)
SELECT h.project_id, h.rule_version, h.to_stage, h.reason, COALESCE(h.facts, '{}'::jsonb),
       md5(h.id::text || ':' || h.to_stage), h.created_at, 'historical_runtime', h.created_at
FROM wr_stage_history h
JOIN wr_projects p ON p.id = h.project_id
WHERE h.source = 'auto' AND h.rule_version IN ('pipeline-v1', 'pipeline-v2')
  AND NOT EXISTS (SELECT 1 FROM wr_screening_snapshots s
                  WHERE s.project_id = h.project_id AND s.rule_version = h.rule_version AND s.created_at = h.created_at);
