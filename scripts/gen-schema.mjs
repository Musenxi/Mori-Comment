// schema.sql → src/schema.ts（Workers 里读不了文件，表结构要跟着代码打包）：pnpm schema
import { readFileSync, writeFileSync } from 'node:fs';

const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
writeFileSync(new URL('../src/schema.ts', import.meta.url), `// 由 schema.sql 生成，不要手改：pnpm schema\nexport const SCHEMA = ${JSON.stringify(sql)};\n`);
