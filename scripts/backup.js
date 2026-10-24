import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const source = join(resolve(process.env.DATA_DIR || './data'), 'cache.sqlite');
const destination = resolve(process.argv[2] || `backups/cache-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try {
  // SQLite online backup includes committed WAL content, unlike copying only the main file.
  await backup(db, destination);
  console.info('Database backup completed.');
} finally {
  db.close();
}