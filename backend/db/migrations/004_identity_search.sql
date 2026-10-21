-- M1：记录项目最近一次「按名称在 Surf 中查找身份」的时间，避免重复花点数
ALTER TABLE wr_projects ADD COLUMN IF NOT EXISTS surf_searched_at timestamptz;
