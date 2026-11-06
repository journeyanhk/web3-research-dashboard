-- M3 Review 修正（2026-11-06）
-- 1. 拆开「数据覆盖率」与「链覆盖折扣」：coverage 列保留兼容，新写入以 data_coverage 为准
-- 2. 评分口径锁定：revision / locked_at / unlock_log 记录在 settings.score_config 中
ALTER TABLE wr_scores
  ADD COLUMN IF NOT EXISTS data_coverage numeric(4,3),
  ADD COLUMN IF NOT EXISTS chain_factor numeric(4,3);

COMMENT ON COLUMN wr_scores.coverage IS '旧字段（兼容）：M3 早期把链折扣当成覆盖率写入；新数据请读 data_coverage';
COMMENT ON COLUMN wr_scores.data_coverage IS '评分所需数据的覆盖程度 0–1（六个维度中有证据的比例）';
COMMENT ON COLUMN wr_scores.chain_factor IS '链数据折扣 0–1（ETH/BSC/Base/Arbitrum 1.0、SOL 0.9、Robinhood 0.8），只作用于行动分';
