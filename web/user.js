(function(){
  const params = new URLSearchParams(window.location.search);
  const TOKEN = params.get('token');
  const GUILD = params.get('guild');
  const sessionDiv = document.getElementById('sessionInfo');
  const guildNameEl = document.getElementById('guildName');
  const nowEl = document.getElementById('now');
  const queueEl = document.getElementById('queueList');
  

  function fetchWithToken(url, opts={}){
    opts.headers = opts.headers || {};
    if (TOKEN) opts.headers['x-web-token'] = TOKEN;
    return fetch(url, opts).then(r => r.json());
  }

  async function loadStatus(){
    if (!GUILD) { sessionDiv.textContent = 'Guild non specificato.'; return; }
    sessionDiv.textContent = `Sessione per guild ${GUILD}`;
    try {
      const s = await fetchWithToken(`/api/guild/${GUILD}/status`);
      if (s && s.guild && s.guild.name) guildNameEl.textContent = s.guild.name;
      nowEl.textContent = s.current ? `Now: ${s.current.title} (${s.current.requestedBy})` : 'Nessuna traccia in riproduzione';
      queueEl.innerHTML = '';
      if (s.queue && s.queue.length) { s.queue.forEach((it,i) => { const d = document.createElement('div'); d.textContent = `${i+1}. ${it.title}`; queueEl.appendChild(d); }); }
    } catch (e) { sessionDiv.textContent = 'Errore caricamento status'; }
  }

  async function postAction(action, body){
    try {
      const res = await fetchWithToken(`/api/guild/${GUILD}/${action}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
      return res;
    } catch (e) { return null; }
  }

  const btnSkip = document.getElementById('btnSkip');
  const btnPause = document.getElementById('btnPause');
  const btnResume = document.getElementById('btnResume');
  const btnStop = document.getElementById('btnStop');
  if (btnSkip) btnSkip.addEventListener('click', async () => { await postAction('skip'); loadStatus(); });
  if (btnPause) btnPause.addEventListener('click', async () => { await postAction('pause'); loadStatus(); });
  if (btnResume) btnResume.addEventListener('click', async () => { await postAction('resume'); loadStatus(); });
  if (btnStop) btnStop.addEventListener('click', async () => { await postAction('stop'); loadStatus(); });

  // volume, shuffle, repeat
  const btnSetVol = document.getElementById('btnSetVol');
  const volInput = document.getElementById('volume');
  if (btnSetVol && volInput) btnSetVol.addEventListener('click', async () => { const v = parseFloat(volInput.value); if (isNaN(v)) return alert('Valore volume non valido'); await postAction('volume', { volume: v }); loadStatus(); });
  const btnShuffle = document.getElementById('btnShuffle');
  if (btnShuffle) btnShuffle.addEventListener('click', async () => { await postAction('toggleShuffle'); loadStatus(); });
  const btnRepeat = document.getElementById('btnRepeat');
  if (btnRepeat) btnRepeat.addEventListener('click', async () => { await postAction('toggleRepeat'); loadStatus(); });

  // initial load
  loadStatus();
  // refresh periodically
  setInterval(loadStatus, 5000);
})();
