const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Simple file watcher that restarts node process when files change.
// Usage: node watch-restart.js [entry=./index.js]

const entry = process.argv[2] || path.join(process.cwd(), 'index.js');
let child = null;
let restarting = false;
let restartTimer = null;
const DEBOUNCE_MS = 300;

function start() {
  if (child) return;
  console.log('[watch-restart] Starting', entry);
  child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, sig) => {
    console.log('[watch-restart] Process exited', code, sig);
    child = null;
  });
}

function stop(cb) {
  if (!child) return cb && cb();
  try {
    console.log('[watch-restart] Stopping process...');
    child.once('exit', () => { child = null; cb && cb(); });
    child.kill('SIGTERM');
    // force kill after timeout
    setTimeout(() => { if (child) { try { child.kill('SIGKILL'); } catch(e){} child = null; cb && cb(); } }, 3000);
  } catch (e) { child = null; cb && cb(); }
}

function scheduleRestart() {
  if (restarting) return;
  restarting = true;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log('[watch-restart] Changes detected — restarting...');
    stop(() => { start(); restarting = false; });
  }, DEBOUNCE_MS);
}

function watchDir(dir) {
  try {
    const watcher = fs.watch(dir, { recursive: true }, (evt, filename) => {
      if (!filename) return;
      // ignore node_modules and .git
      if (filename.includes('node_modules') || filename.includes('.git')) return;
      // only react to .js, .json, .env, .html, .css changes
      const ext = path.extname(filename).toLowerCase();
      if (!['.js', '.env'].includes(ext) && ext !== '') return;
      scheduleRestart();
    });
    watcher.on('error', (e) => { /* ignore */ });
  } catch (e) {
    console.warn('[watch-restart] fs.watch failed on', dir, e && e.message);
  }
}

start();
// watch project root
watchDir(process.cwd());
// also watch web folder if exists
try { if (fs.existsSync(path.join(process.cwd(), 'web'))) watchDir(path.join(process.cwd(), 'web')); } catch(e){}

process.on('SIGINT', () => { console.log('[watch-restart] Exiting...'); stop(() => process.exit(0)); });
process.on('SIGTERM', () => { console.log('[watch-restart] Exiting...'); stop(() => process.exit(0)); });
