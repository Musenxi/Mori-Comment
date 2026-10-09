-- 给已经建好的 D1 数据库加上“垃圾箱”状态：status 的约束要改，SQLite 只能重建表（新建的库直接用 schema.sql，不需要这个）。
-- 先执行过 001–003，再执行一次：wrangler d1 execute <库名> --file=migrations-004-spam.sql，然后再执行一次 schema.sql（建索引）
-- 以前只存哈希的 email_hash、ip_hash 两列会去掉。parent_id 先指向新表自己，改名后 SQLite 会跟着改成 comments（指向旧表的话，删旧表时外键会报错）。（Node + SQLite 的评论服务启动时会自动重建，不用手动执行。）
PRAGMA defer_foreign_keys = true;
CREATE TABLE comments_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry       TEXT    NOT NULL,
  block       TEXT,
  start       INTEGER,
  "end"       INTEGER,
  quote       TEXT,
  prefix      TEXT,
  suffix      TEXT,
  body        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  email       TEXT,
  avatar_hash TEXT,
  url         TEXT,
  ip          TEXT,
  author      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden', 'spam')),
  parent_id   INTEGER REFERENCES comments_new(id)
);
INSERT INTO comments_new (id, entry, block, start, "end", quote, prefix, suffix, body, name, email, avatar_hash, url, ip, author, created_at, status, parent_id)
  SELECT id, entry, block, start, "end", quote, prefix, suffix, body, name, email, avatar_hash, url, ip, author, created_at, status, parent_id FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
