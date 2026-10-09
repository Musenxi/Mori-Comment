-- 给已经建好的 D1 数据库补上“博主发的”一列（新建的库直接用 schema.sql，不需要这个）。
-- 只执行一次：wrangler d1 execute <库名> --file=migrations-003-author.sql
-- （Node + SQLite 的评论服务启动时会自动补，不用手动执行。）
ALTER TABLE comments ADD COLUMN author INTEGER NOT NULL DEFAULT 0;
