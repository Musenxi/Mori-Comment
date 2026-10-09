-- 给已经建好的 D1 数据库补上邮箱、IP 两列（以前只存加盐哈希；新建的库直接用 schema.sql，不需要这个）。
-- 只执行一次：wrangler d1 execute <库名> --file=migrations-002-ip.sql，然后再执行一次 schema.sql（建新索引）
-- （Node + SQLite 的评论服务启动时会自动补，不用手动执行。）
ALTER TABLE comments ADD COLUMN email TEXT;
ALTER TABLE comments ADD COLUMN ip TEXT;
