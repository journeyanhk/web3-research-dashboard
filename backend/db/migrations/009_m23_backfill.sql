-- M2.3 回填（不花点数，只用已归档的原始数据与已有事件）

-- 回填：Surf 项目标签（来自已归档的项目详情原始数据，不花点数）
UPDATE wr_projects p SET tags = r.tags
FROM (SELECT DISTINCT ON (params->>'id') params->>'id' AS sid, body->'data'->'overview'->'tags' AS tags
      FROM wr_raw_responses WHERE endpoint = 'project/detail' AND status = 'ok'
        AND jsonb_typeof(body->'data'->'overview'->'tags') = 'array'
      ORDER BY params->>'id', fetched_at DESC) r
WHERE p.surf_project_id = r.sid AND p.tags IS NULL;

-- 回填：链信息来源
UPDATE wr_projects p SET chain_source = 'surf_detail'
WHERE chain_source IS NULL AND jsonb_array_length(COALESCE(chains,'[]'::jsonb)) > 0
  AND (EXISTS (SELECT 1 FROM wr_project_ids i WHERE i.project_id = p.id AND i.id_type = 'contract')
       OR EXISTS (SELECT 1 FROM wr_raw_responses r WHERE r.endpoint = 'project/detail' AND r.status = 'ok'
                    AND r.params->>'id' = p.surf_project_id
                    AND jsonb_array_length(COALESCE(r.body->'data'->'overview'->'chains','[]'::jsonb)) > 0));
UPDATE wr_projects p SET chain_source = 'airdrop_task'
WHERE chain_source IS NULL AND jsonb_array_length(COALESCE(chains,'[]'::jsonb)) > 0
  AND EXISTS (SELECT 1 FROM wr_events e WHERE e.project_id = p.id AND e.event_type = 'airdrop'
                AND jsonb_array_length(COALESCE(e.chains,'[]'::jsonb)) > 0);
UPDATE wr_projects SET chain_source = 'inferred'
WHERE chain_source IS NULL AND jsonb_array_length(COALESCE(chains,'[]'::jsonb)) > 0;
