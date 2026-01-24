// read token/guild from URL params (if user opened /user/:token redirect)
const URL_PARAMS = new URLSearchParams(window.location.search);
const WEB_TOKEN = URL_PARAMS.get('token') || null;
const AUTO_GUILD = URL_PARAMS.get('guild') || null;
// optional global web secret (password) used to authenticate admin UI access
let WEB_SECRET = null;

function fetchWithToken(url, opts = {}) {
  opts.headers = opts.headers || {};
  if (WEB_TOKEN) opts.headers['x-web-token'] = WEB_TOKEN;
  if (WEB_SECRET) opts.headers['x-web-secret'] = WEB_SECRET;
  return fetch(url, opts).then(r => r.json());
}

const api = {
  get: (p) => fetchWithToken(p),
  post: (p, body) => fetchWithToken(p, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }),
};

// Enforce admin-only access to this UI: validate token if present; otherwise prompt for password.
async function ensureAdminOrPassword() {
  // if token present, prefer it and check admin flag
  if (WEB_TOKEN) {
    try {
      const info = await fetchWithToken(`/api/websession/${encodeURIComponent(WEB_TOKEN)}`);
      if (info && info.ok && info.admin) return true;
      // if token exists but not admin, fall through to password prompt
    } catch (e) {
      // ignore and fall through to password prompt
    }
  }

  // show a modal password prompt (non-blocking) instead of prompt()
  const pwd = await showPasswordModal();
  if (!pwd) { alert('Accesso annullato'); redirectToPrevious(); return false; }

  // test password against a protected endpoint; if valid, store it for subsequent requests
  try {
    const res = await fetch('/api/guilds', { headers: { 'x-web-secret': pwd } });
    const json = await res.json();
    if (Array.isArray(json)) {
      WEB_SECRET = pwd;
      return true;
    }
  } catch (e) {
    // ignore and show error below
  }
  alert('Password non valida');
  redirectToPrevious();
  return false;
}

function redirectToPrevious() {
  // prefer HTTP referrer, otherwise try history.back(), otherwise fallback to user page
  const prev = document.referrer;
  if (prev) {
    window.location.href = prev;
    return;
  }
  if (window.history && window.history.length > 1) {
    window.history.back();
    return;
  }
  // fallback to user view for the current guild
  const g = AUTO_GUILD || '';
  window.location.href = `/user.html?guild=${encodeURIComponent(g)}`;
}

// create and show a lightweight modal password prompt; resolves with the password string or null
function showPasswordModal() {
  return new Promise((resolve) => {
    const modal = document.getElementById('webSecretModal');
    const input = document.getElementById('webSecretInput');
    const remember = document.getElementById('webSecretRemember');
    const err = document.getElementById('webSecretErr');
    const ok = document.getElementById('webSecretOk');
    const cancel = document.getElementById('webSecretCancel');

    if (!modal || !input || !ok || !cancel) {
      // fallback: prompt
      const val = prompt('Inserisci password admin:');
      resolve(val || null);
      return;
    }

    // auto-fill from localStorage if present
    const saved = localStorage.getItem('web_secret');
    if (saved) input.value = saved;

    modal.style.display = 'flex';
    err.textContent = '';

    function cleanup() {
      modal.style.display = 'none';
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
    }

    async function onOk() {
      const val = input.value || '';
      if (!val) { err.textContent = 'Inserire la password'; input.focus(); return; }
      // validate by calling protected endpoint
      try {
        const res = await fetch('/api/guilds', { headers: { 'x-web-secret': val } });
        const j = await res.json();
        if (Array.isArray(j)) {
          if (remember && remember.checked) localStorage.setItem('web_secret', val);
          cleanup();
          resolve(val);
          return;
        }
      } catch (e) {}
      err.textContent = 'Password non valida';
      input.focus();
    }

    function onCancel() { cleanup(); resolve(null); }

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onOk(); if (ev.key === 'Escape') onCancel(); });
    setTimeout(() => input.focus(), 50);
  });
}

async function refreshGuilds() {
  // ensure admin permissions (via token or password) before continuing
  const ok = await ensureAdminOrPassword();
  if (!ok) return;
  const list = await api.get('/api/guilds');
  const sel = document.getElementById('guilds');
  sel.innerHTML = '';
  list.forEach(g => { const o = document.createElement('option'); o.value = g.id; o.textContent = g.name; sel.appendChild(o); });
  if (list.length) {
    const pick = AUTO_GUILD && list.find(x => x.id === AUTO_GUILD) ? AUTO_GUILD : list[0].id;
    // set selection and load status/channels
    sel.value = pick;
    await loadStatus(pick);
    try { await loadChannels(pick); } catch (e) {}
  }
}

async function loadStatus(gid) {
  if (!gid) return;
  const s = await api.get(`/api/guild/${gid}/status`);
  document.getElementById('guildName').textContent = s.guild ? s.guild.name : `Guild ${gid}`;
  const now = document.getElementById('now');
  now.textContent = s.current ? `Now: ${s.current.title} (${s.current.requestedBy})` : 'Nessuna traccia in riproduzione';
  const ql = document.getElementById('queueList');
  ql.innerHTML = '';
  if (s.queue && s.queue.length) {
    s.queue.forEach((it,i) => { const d = document.createElement('div'); d.textContent = `${i+1}. ${it.title}`; ql.appendChild(d); });
  }
  // set volume input from server (which reads persisted settings when no active queue)
  document.getElementById('volume').value = (typeof s.volume === 'number' && !isNaN(s.volume)) ? s.volume : 0.8;
  // load playlists for the guild
  loadPlaylists(gid);
}

function selectedGuild() { return document.getElementById('guilds').value; }

document.getElementById('refreshGuilds').addEventListener('click', () => refreshGuilds());
document.getElementById('guilds').addEventListener('change', (e) => { loadStatus(e.target.value); loadChannels(e.target.value); loadTrash(e.target.value); });
document.getElementById('btnSkip').addEventListener('click', async () => { await api.post(`/api/guild/${selectedGuild()}/skip`); loadStatus(selectedGuild()); });
document.getElementById('btnPause').addEventListener('click', async () => { await api.post(`/api/guild/${selectedGuild()}/pause`); loadStatus(selectedGuild()); });
document.getElementById('btnResume').addEventListener('click', async () => { await api.post(`/api/guild/${selectedGuild()}/resume`); loadStatus(selectedGuild()); });
document.getElementById('btnStop').addEventListener('click', async () => { await api.post(`/api/guild/${selectedGuild()}/stop`); loadStatus(selectedGuild()); });
document.getElementById('btnClearQueue').addEventListener('click', async () => {
  const gid = selectedGuild();
  if (!gid) return alert('Seleziona un server.');
  if (!confirm('Svuotare la coda (upcoming tracks)?')) return;
  try {
    await api.post(`/api/guild/${gid}/clearQueue`);
    loadStatus(gid);
  } catch (e) { alert('Errore durante lo svuotamento della coda'); }
});
document.getElementById('btnSetVol').addEventListener('click', async () => { const v = parseFloat(document.getElementById('volume').value); await api.post(`/api/guild/${selectedGuild()}/volume`, { volume: v }); loadStatus(selectedGuild()); });
document.getElementById('btnShuffle').addEventListener('click', async () => { await api.post(`/api/guild/${selectedGuild()}/toggleShuffle`); loadStatus(selectedGuild()); });
document.getElementById('btnRepeat').addEventListener('click', async () => { await api.post(`/api/guild/${selectedGuild()}/toggleRepeat`); loadStatus(selectedGuild()); });

document.getElementById('btnSend').addEventListener('click', async () => {
  const sel = document.getElementById('channelSelect');
  const ch = sel ? sel.value : null;
  const content = document.getElementById('msgContent').value;
  if (!ch) return alert('Seleziona un canale dal menu.');
  await api.post(`/api/guild/${selectedGuild()}/send`, { channelId: ch, content });
});

window.addEventListener('load', () => { refreshGuilds(); setTimeout(() => { const g = selectedGuild(); if (g) { loadTrash(g); loadChannels(g); } }, 800); });

// load channels for guild
async function loadChannels(gid) {
  const sel = document.getElementById('channelSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- seleziona --</option>';
  if (!gid) return;
  try {
    const list = await api.get(`/api/guild/${gid}/channels`);
    if (!list) {
      console.warn('loadChannels: empty response');
      return;
    }
    if (list.error) { console.warn('loadChannels API error:', list.error); return; }
    if (!Array.isArray(list)) return;
    // deduplicate by id and sort by name for stable ordering
    const seen = new Set();
    const unique = [];
    list.forEach(c => {
      if (!c || !c.id) return;
      if (seen.has(c.id)) return;
      seen.add(c.id);
      unique.push(c);
    });
    unique.sort((a,b) => ((a.name||'').toLowerCase()).localeCompare((b.name||'').toLowerCase()));
    unique.forEach(c => {
      const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.name} (${c.id})`; sel.appendChild(o);
    });
    // when selecting a channel, nothing else to populate — the select value is used directly
  } catch (e) {
    // ignore
  }
}

async function loadPlaylists(gid) {
  const list = await api.get(`/api/guild/${gid}/playlists`);
  const container = document.getElementById('playlistList');
  container.innerHTML = '';
  if (!list || list.length === 0) { container.textContent = 'Nessuna playlist salvata.'; return; }
  list.forEach(fname => {
    const row = document.createElement('div');
    row.className = 'playlistRow';
    const name = document.createElement('span'); name.textContent = fname;
    const editBtn = document.createElement('button'); editBtn.textContent = 'Modifica';
    editBtn.addEventListener('click', async () => {
      // open editor
      document.getElementById('playlistEditor').style.display = 'block';
      document.getElementById('editorTitle').textContent = `Modifica: ${fname}`;
      const ed = document.getElementById('editorTracks'); ed.innerHTML = 'Caricamento...';
      try {
        const json = await api.get(`/api/guild/${gid}/playlists/${encodeURIComponent(fname)}`);
        const items = json && Array.isArray(json.items) ? json.items : [];
        renderEditor(items, fname, gid);
        // inform server that this playlist is currently selected in the web UI
        try { await api.post(`/api/guild/${gid}/currentPlaylist`, { filename: fname }); } catch (e) { /* ignore */ }
      } catch (e) { ed.textContent = 'Errore caricamento'; }
    });
    const renameBtn = document.createElement('button'); renameBtn.textContent = 'Rinomina';
    renameBtn.addEventListener('click', async () => {
      const newName = prompt('Nuovo nome playlist (senza estensione):');
      if (!newName) return;
      renameBtn.disabled = true; renameBtn.textContent = 'Rinominando...';
      try {
        const res = await api.post(`/api/guild/${gid}/playlists/${encodeURIComponent(fname)}/rename`, { newName });
        if (res && res.ok) {
          alert('Rinomina completata: ' + res.filename);
          loadPlaylists(gid); loadTrash(gid);
        } else {
          alert('Errore rinomina'); renameBtn.disabled = false; renameBtn.textContent = 'Rinomina';
        }
      } catch (e) { alert('Errore rinomina'); renameBtn.disabled = false; renameBtn.textContent = 'Rinomina'; }
    });
    const btn = document.createElement('button'); btn.textContent = 'Aggiungi alla coda';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Aggiungendo...';
      await api.post(`/api/guild/${gid}/playplaylist`, { filename: fname });
      btn.textContent = 'Aggiunto';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Aggiungi alla coda'; }, 2000);
      loadStatus(gid);
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Elimina';
    delBtn.style.marginLeft = '8px';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Eliminare la playlist ${fname}?`)) return;
      delBtn.disabled = true; delBtn.textContent = 'Eliminando...';
      try {
        const json = await fetchWithToken(`/api/guild/${gid}/playlists/${encodeURIComponent(fname)}`, { method: 'DELETE' });
        if (json && json.ok) { row.remove(); } else { alert('Errore durante l\'eliminazione'); delBtn.disabled = false; delBtn.textContent = 'Elimina'; }
      } catch (e) {
        alert('Errore durante l\'eliminazione');
        delBtn.disabled = false; delBtn.textContent = 'Elimina';
      }
    });
    row.appendChild(name); row.appendChild(btn); row.appendChild(editBtn); row.appendChild(renameBtn); row.appendChild(delBtn); container.appendChild(row);
  });
}

function renderEditor(items, fname, gid) {
  const ed = document.getElementById('editorTracks'); ed.innerHTML = '';
  function renderList() {
    ed.innerHTML = '';
    items.forEach((it, idx) => {
      const r = document.createElement('div'); r.className = 'editorRow';
      const t = document.createElement('input'); t.value = it.title || ''; t.placeholder = 'Titolo'; t.style.width = '40%';
      const u = document.createElement('input'); u.value = it.url || ''; u.placeholder = 'URL'; u.style.width = '45%';
      const up = document.createElement('button'); up.textContent = '↑'; up.addEventListener('click', () => { if (idx>0) { const tmp = items[idx-1]; items[idx-1]=items[idx]; items[idx]=tmp; renderList(); } });
      const down = document.createElement('button'); down.textContent = '↓'; down.addEventListener('click', () => { if (idx<items.length-1) { const tmp = items[idx+1]; items[idx+1]=items[idx]; items[idx]=tmp; renderList(); } });
      const rem = document.createElement('button'); rem.textContent = 'Rimuovi'; rem.addEventListener('click', () => { items.splice(idx,1); renderList(); });
      t.addEventListener('input', () => items[idx].title = t.value);
      u.addEventListener('input', () => items[idx].url = u.value);
      r.appendChild(t); r.appendChild(u); r.appendChild(up); r.appendChild(down); r.appendChild(rem);
      ed.appendChild(r);
    });
  }
  renderList();

  document.getElementById('addTrackBtn').onclick = () => { items.push({ title: '', url: '' }); renderList(); };
  document.getElementById('savePlaylistBtn').onclick = async () => {
    try {
      const payload = { items, requestedBy: 'web' };
      const saved = await api.post(`/api/guild/${gid}/playlists/${encodeURIComponent(fname)}`, payload);
      if (saved && saved.ok) {
        alert('Playlist salvata'); document.getElementById('playlistEditor').style.display = 'none'; loadPlaylists(gid); loadStatus(gid);
      } else alert('Errore salvataggio');
    } catch (e) { alert('Errore salvataggio'); }
  };
  document.getElementById('cancelEditBtn').onclick = () => { document.getElementById('playlistEditor').style.display = 'none'; };
}

document.getElementById('createPlaylistBtn').addEventListener('click', async () => {
  const gid = selectedGuild();
  const name = document.getElementById('newPlaylistName').value.trim();
  if (!name) { alert('Inserisci un nome'); return; }
  try {
    const res = await api.post(`/api/guild/${gid}/playlists`, { name, items: [] });
    if (res && res.ok && res.filename) { alert('Playlist creata: ' + res.filename); loadPlaylists(gid); document.getElementById('newPlaylistName').value = ''; }
    else alert('Errore creazione');
  } catch (e) { alert('Errore creazione'); }
});

// ensure trash is also loaded when guild changes
document.getElementById('guilds').addEventListener('change', (e) => { loadStatus(e.target.value); loadTrash(e.target.value); });
document.getElementById('refreshGuilds').addEventListener('click', () => { const g = selectedGuild(); if (g) { loadTrash(g); } });

window.addEventListener('load', () => { refreshGuilds(); setTimeout(() => { const g = selectedGuild(); if (g) { loadTrash(g); } }, 800); });

async function loadTrash(gid) {
  const container = document.getElementById('trashList');
  const badge = document.getElementById('trashBadge');
  container.innerHTML = '';
  if (!gid) { container.textContent = 'Seleziona un server.'; if (badge) badge.textContent = '0'; return; }
  let list = [];
  try {
    const resp = await api.get(`/api/guild/${gid}/playlists/trash`);
    list = Array.isArray(resp) ? resp : [];
  } catch (e) {
    list = [];
  }
  if (!list || list.length === 0) { container.textContent = 'Cestino vuoto.'; if (badge) badge.textContent = '0'; return; }
  if (badge) badge.textContent = String(list.length);
  list.forEach(fname => {
    const row = document.createElement('div'); row.className = 'playlistRow';
    const name = document.createElement('span'); name.textContent = fname;
    const restoreBtn = document.createElement('button'); restoreBtn.textContent = 'Ripristina';
    restoreBtn.addEventListener('click', async () => {
      if (!confirm(`Ripristinare la playlist ${fname}?`)) return;
      restoreBtn.disabled = true; restoreBtn.textContent = 'Ripristino...';
      try {
        const json = await api.post(`/api/guild/${gid}/playlists/trash/restore`, { filename: fname });
        if (json && json.ok) {
          row.remove(); loadPlaylists(gid); loadStatus(gid);
          try { const list2 = await api.get(`/api/guild/${gid}/playlists/trash`); if (badge) badge.textContent = String(Array.isArray(list2) ? list2.length : 0); } catch (e) {}
        } else {
          alert('Errore durante il ripristino'); restoreBtn.disabled = false; restoreBtn.textContent = 'Ripristina';
        }
      } catch (e) { alert('Errore durante il ripristino'); restoreBtn.disabled = false; restoreBtn.textContent = 'Ripristina'; }
    });
    const permDel = document.createElement('button'); permDel.textContent = 'Elimina definitivamente'; permDel.style.marginLeft = '8px';
    permDel.addEventListener('click', async () => {
      if (!confirm(`Eliminare definitivamente ${fname}?`)) return;
      permDel.disabled = true; permDel.textContent = 'Eliminando...';
      try {
        const j = await fetchWithToken(`/api/guild/${gid}/playlists/trash/${encodeURIComponent(fname)}`, { method: 'DELETE' });
        if (j && j.ok) { row.remove(); } else { alert('Errore durante l\'eliminazione'); permDel.disabled = false; permDel.textContent = 'Elimina definitivamente'; }
      } catch (e) { alert('Errore durante l\'eliminazione'); permDel.disabled = false; permDel.textContent = 'Elimina definitivamente'; }
      // update badge after deletion
      try { const list2 = await api.get(`/api/guild/${gid}/playlists/trash`); if (badge) badge.textContent = String(list2.length); } catch (e) {}
    });
    row.appendChild(name); row.appendChild(restoreBtn); row.appendChild(permDel); container.appendChild(row);
  });
}

// update badge when playlists change
async function refreshTrashBadge(gid) {
  try {
    const badge = document.getElementById('trashBadge');
    if (!badge || !gid) return;
    const list = await api.get(`/api/guild/${gid}/playlists/trash`);
    badge.textContent = list && Array.isArray(list) ? String(list.length) : '0';
  } catch (e) {}
}
