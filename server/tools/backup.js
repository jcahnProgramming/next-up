// Backups by hand (RESTORE.md). Runs inside the app image, where DATA_DIR and BACKUP_DIR are set:
//
//   node server/tools/backup.js now             take a backup now, the same way the nightly one does
//   node server/tools/backup.js verify <file>   check a backup file: integrity_check, and what's in it
//   node server/tools/backup.js list            the backups in BACKUP_DIR, newest first
import { basename } from 'node:path';
import { listBackups, runBackup, verifyBackup } from '../core/backup.js';
import { config } from '../core/config.js';
import { closeDb, getDb } from '../core/db.js';

const [command, file] = process.argv.slice(2);
const fail = (message) => {
  console.error(`[backup] FAILED: ${message}`);
  process.exit(1);
};

try {
  if (command === 'verify' && file) {
    const counts = verifyBackup(file);
    console.log(`[backup] ${basename(file)}: integrity ok, ${counts.boards} boards, ${counts.events} events`);
  } else if (command === 'now' || command === 'list') {
    if (!config.backupDir) fail('BACKUP_DIR is not set');
    if (command === 'list') {
      for (const b of listBackups(config.backupDir)) console.log(b.name);
    } else {
      const r = await runBackup({ db: getDb(), dir: config.backupDir, stagingDir: config.dataDir });
      closeDb();
      console.log(`[backup] ${r.file}: ${r.bytes} bytes, integrity ok, ${r.boards} boards, ${r.events} events`);
    }
  } else {
    console.error('Usage: node server/tools/backup.js now | list | verify <file>');
    process.exit(2);
  }
} catch (err) {
  fail(`${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}`);
}
