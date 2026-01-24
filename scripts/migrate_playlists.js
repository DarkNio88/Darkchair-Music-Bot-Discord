const fs = require('fs');
const path = require('path');

const PLAYLISTS_DIR = path.join(process.cwd(), 'playlists');
const LOG = path.join(process.cwd(), 'playlist_actions.log');

function ensureDir(d) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('Failed to ensure dir', d, e); }
}

ensureDir(PLAYLISTS_DIR);

const entries = fs.readdirSync(PLAYLISTS_DIR);
let moved = 0;
let skipped = 0;
let errors = 0;
const movedList = [];

for (const name of entries) {
  try {
    const full = path.join(PLAYLISTS_DIR, name);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) { skipped++; continue; }
    if (!name.toLowerCase().endsWith('.json')) { skipped++; continue; }

    // try to detect a guild id (17-20 digits)
    const m = name.match(/(\d{17,20})/);
    const gid = m ? m[1] : 'unknown';

    const destDir = path.join(PLAYLISTS_DIR, gid);
    ensureDir(destDir);

    let destName = name;
    let dest = path.join(destDir, destName);
    if (fs.existsSync(dest)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let c = 1;
      while (fs.existsSync(dest)) {
        destName = `${base}_migrated_${c}${ext}`;
        dest = path.join(destDir, destName);
        c += 1;
      }
    }

    fs.renameSync(full, dest);
    moved++;
    movedList.push({ from: full, to: dest });
    const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'migrate_playlist', from: full, to: dest }) + '\n';
    try { fs.appendFileSync(LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to append log', e); }
  } catch (e) {
    errors++;
    console.error('Error migrating', name, e && e.message ? e.message : e);
  }
}

console.log(`Migration complete. moved=${moved}, skipped=${skipped}, errors=${errors}`);
if (movedList.length) console.log('Moved files:\n' + movedList.map(i => `${i.from} -> ${i.to}`).join('\n'));
