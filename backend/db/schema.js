// 本项目使用独立的 PostgreSQL（Neon），表结构由 db/migrations/*.sql 管理，
// 启动时由 lib/db.js 自动执行未应用的迁移。
// 这里故意不导出任何表：避免平台在账号共享数据库（已达 50 张表上限）中建表。
