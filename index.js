require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const yts = require('yt-search');
const yt = require('darkchair_api_youtube');
// `ytdl-core-discord` removed — relying on `yt-dlp` via `darkchair_api_yt`
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
let sharpLib = null;
try {
  sharpLib = require('sharp');
  console.log('sharp available: SVG->PNG conversion enabled');
} catch (e) {
  sharpLib = null;
  console.log('sharp not available: will send SVG attachments (install sharp for PNG output)');
}

const LAST_TRACKS_FILE = path.join(process.cwd(), 'last_tracks.json');
let lastTracks = {};
const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
let settings = {};
const PLAYLISTS_DIR = path.join(process.cwd(), 'playlists');
try { if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR); } catch (e) { console.error('Could not ensure playlists dir:', e); }
const PLAYLISTS_TRASH_DIR = path.join(process.cwd(), 'playlists_trash');
try { if (!fs.existsSync(PLAYLISTS_TRASH_DIR)) fs.mkdirSync(PLAYLISTS_TRASH_DIR); } catch (e) { console.error('Could not ensure playlists_trash dir:', e); }
const PLAYLIST_ACTIONS_LOG = path.join(process.cwd(), 'playlist_actions.log');

// In-memory web sessions (token -> { guild, user, expires })
const webSessions = new Map();

function createWebSession(guildId, userId, ttlMs = 1000 * 60 * 60, admin = false) {
  const token = (Math.random().toString(36).slice(2) + Date.now().toString(36));
  const expires = Date.now() + ttlMs;
  webSessions.set(token, { guild: String(guildId), user: String(userId), expires, admin: !!admin });
  return token;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [k, v] of webSessions.entries()) {
    if (v.expires && v.expires < now) webSessions.delete(k);
  }
}
setInterval(cleanupExpiredSessions, 60 * 1000);

// Helper: per-guild playlist and trash directories
function guildPlaylistsDir(gid) {
  const d = path.join(PLAYLISTS_DIR, String(gid));
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('Could not ensure guild playlists dir:', d, e); }
  return d;
}

function guildTrashDir(gid) {
  const d = path.join(PLAYLISTS_TRASH_DIR, String(gid));
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('Could not ensure guild trash dir:', d, e); }
  return d;
}
function loadLastTracks() {
  try {
    if (fs.existsSync(LAST_TRACKS_FILE)) {
      const raw = fs.readFileSync(LAST_TRACKS_FILE, 'utf8') || '{}';
      lastTracks = JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load last tracks file:', e && e.message ? e.message : e);
    lastTracks = {};
  }
}
function saveLastTracks() {
  try {
    fs.writeFileSync(LAST_TRACKS_FILE, JSON.stringify(lastTracks, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save last tracks file:', e && e.message ? e.message : e);
  }
}
loadLastTracks();

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}';
      settings = JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load settings file:', e && e.message ? e.message : e);
    settings = {};
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings file:', e && e.message ? e.message : e);
  }
}
loadSettings();

async function replyAndDelete(triggerMessage, content, ms = 10000) {
  try {
    const sent = await triggerMessage.reply(content);
    setTimeout(() => { try { sent.delete(); } catch (e) {} }, ms);
    return sent;
  } catch (e) {
    console.error('Failed to send ephemeral reply:', e && e.message ? e.message : e);
    return null;
  }
}

// Reply and optionally delete the triggering user message when requested
async function replyAndDeleteAndMaybeRemoveTrigger(triggerMessage, content, ms = 10000, deleteTrigger = false) {
  const sent = await replyAndDelete(triggerMessage, content, ms);
  if (deleteTrigger && triggerMessage && typeof triggerMessage.delete === 'function') {
    try { await triggerMessage.delete().catch(() => {}); } catch (e) {}
  }
  return sent;
}

// Using `darkchair_api_yt.getInfo` for metadata

const PREFIX = '!';
// Prefer token from environment variables; fall back to any hardcoded TOKEN in file
const TOKEN = process.env.BOT_TOKEN || process.env.TOKEN || process.env.DISCORD_TOKEN || null;

// Array of author tags to ignore in debug logging
const IGNORED_AUTHORS = ['GS Defender#7592', 'ProBot ✨#5803'];

if (!TOKEN) {
  console.error('Bot token missing. Set BOT_TOKEN (or TOKEN / DISCORD_TOKEN) in .env or environment.');
  process.exit(1);
}
console.log('Starting bot — tokenPresent=', TOKEN ? true : false);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });

// Per-guild queues
const queues = new Map();

function createQueue(guildId) {
  const player = createAudioPlayer();
  player.on('error', (err) => {
    console.error(`Audio player error (guild ${guildId}):`, err);
    const q = queues.get(guildId);
    if (q) {
      try { playNext(guildId); } catch (e) { console.error('Error advancing queue after player error:', e); }
    }
  });

  // load saved settings for this guild if present
  const s = settings[guildId] || {};
  return {
    songs: [],
    connection: null,
    player,
    playing: false,
    current: null,
    lastRequested: lastTracks[guildId] || null,
    history: [],
    startedAt: null,
    currentDuration: 0,
    controlsMessage: null,
    controlsInterval: null,
    controlChannelId: null,
    volume: typeof s.volume === 'number' ? s.volume : 1.0,
    repeatMode: s.repeatMode || 'off', // 'off' | 'one' | 'all'
    shuffleEnabled: !!s.shuffle,
  };
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  let song;
  // If a one-time forced skip was requested (e.g., by the Next button), honor it
  const forceSkipOnce = !!q._forceSkipOnce;
  if (forceSkipOnce) q._forceSkipOnce = false;
  if (q.repeatMode === 'one' && q.current && !forceSkipOnce) {
    // repeat current track
    song = q.current;
  } else {
    song = q.songs.shift();
  }
  // Push previous current into history before replacing (unless repeating same)
  if (q.current && song !== q.current) {
    try { q.history.push(q.current); } catch (e) {}
  }
  // If we've reached end of queue and repeat all is enabled, rebuild the queue
  if (!song && q.repeatMode === 'all') {
    try {
      const all = (q.history && q.history.length ? q.history.slice() : []);
      if (q.current) all.push(q.current);
      q.songs = all;
      q.history = [];
      song = q.songs.shift();
    } catch (e) { song = null; }
  }
  q.current = song || null;
  if (!song) {
    q.playing = false;
    setTimeout(() => {
      try {
        if (q.player.state.status === 'idle' && q.connection) {
          try { q.connection.destroy(); } catch (e) {}
          // clear controls interval and message
          try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
          try { if (q.controlsMessage) q.controlsMessage.delete().catch(()=>{}); } catch (e) {}
          queues.delete(guildId);
        }
      } catch (e) { console.error('playNext cleanup error', e); }
    }, 30000);
    return;
  }

  try {
    const resource = await getAudioResourceFrom(song.url, guildId);
    if (!resource) {
      console.error('Impossibile ottenere risorsa audio per', song.url);
      playNext(guildId);
      return;
    }
    q.player.play(resource);
    q.playing = true;

    // record start time and try to get duration metadata
    try {
      q.startedAt = Date.now();
      const info = await yt.getInfo(song.url);
      q.currentDuration = info ? (info.duration || info.length_seconds || 0) * 1000 : 0;
      // store thumbnail, format and bitrate for richer SVG
      try {
        q.currentThumbnail = info && (info.thumbnail || (info.thumbnails && info.thumbnails[0] && info.thumbnails[0].url)) ? (info.thumbnail || (info.thumbnails && info.thumbnails[0] && info.thumbnails[0].url)) : null;
        q.currentFormat = info && (info.format || (info.formats && info.formats[0] && (info.formats[0].format || info.formats[0].ext))) ? (info.format || (info.formats && info.formats[0] && (info.formats[0].format || info.formats[0].ext))) : null;
        q.currentBitrate = info && (info.abr || info.tbr) ? (info.abr || info.tbr) : 0;
      } catch (e) {
        q.currentThumbnail = null; q.currentFormat = null; q.currentBitrate = 0;
      }
    } catch (e) { q.currentDuration = 0; q.currentThumbnail = null; q.currentFormat = null; q.currentBitrate = 0; }

    // Auto-post controls message to the remembered text channel when playback starts
    try {
      if (!q.controlsMessage && q.controlChannelId) {
        const channel = await client.channels.fetch(q.controlChannelId).catch(() => null);
        if (channel && typeof channel.send === 'function') {
          const payload = await buildControlsMessageForQueue(q, guildId);
          const sent = await channel.send(payload).catch(() => null);
          if (sent) {
            q.controlsMessage = sent;
            try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
            q.controlsInterval = setInterval(() => updateControlsMessage(guildId), 5000);
          }
        }
      }
    } catch (e) { console.error('auto send controls error', e); }

    q.player.once(AudioPlayerStatus.Idle, () => {
      playNext(guildId);
    });
  } catch (err) {
    console.error('Errore riproduzione:', err);
    playNext(guildId);
  }
}

async function getAudioResourceFrom(url, guildId) {
  try {
    const { stream, proc } = yt.stream(url);
    if (!stream) {
      console.error('yt.stream did not return a readable stream for', url);
      return null;
    }

    // Wrap the incoming stream into a PassThrough to decouple child process stdout
    // from the audio resource consumer and to handle premature close more gracefully.
    const outStream = new PassThrough();
    stream.on('error', (err) => {
      console.error('yt stream error:', err);
      try { outStream.destroy(err); } catch (e) {}
      try { if (proc && proc.kill) proc.kill(); } catch (e) {}
    });
    // Pipe yt-dlp stdout into our passthrough
    try { stream.pipe(outStream); } catch (e) { console.error('pipe error:', e); }

    let info = null;
    try {
      info = await yt.getInfo(url);
      if (!info) console.error('yt.getInfo returned no metadata for', url);
    } catch (e) {
      console.warn('getInfo failed for', url, e && e.message ? e.message : e);
    }

    let resource = null;
    try {
      resource = createAudioResource(outStream, { inputType: StreamType.Arbitrary, inlineVolume: true });
      if (resource && resource.volume) resource.volume.setVolume(0.8);
    } catch (e) {
      console.error('Failed to create audio resource:', e && e.message ? e.message : e);
      try { outStream.destroy(); } catch (er) {}
      try { if (proc && proc.kill) proc.kill(); } catch (er) {}
      return null;
    }

    // Ensure process is killed when streams end/close
    outStream.once('close', () => { try { if (proc && proc.kill) proc.kill(); } catch (e) {} });
    outStream.once('end', () => { try { if (proc && proc.kill) proc.kill(); } catch (e) {} });
    stream.once('close', () => { try { if (proc && proc.kill) proc.kill(); } catch (e) {} });
    stream.once('end', () => { try { if (proc && proc.kill) proc.kill(); } catch (e) {} });

    return resource;
  } catch (err) {
    console.error('yt-dlp stream failed:', err);
    return null;
  }
}

// Fetch playlist items using yt-dlp (returns array of { title, url })
async function fetchPlaylistItems(listUrl, limit = 100) {
  return new Promise((resolve) => {
    try {
      const args = ['--flat-playlist', '--dump-single-json', '--no-warnings', listUrl];
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('error', (e) => { console.error('fetchPlaylistItems spawn error:', e && e.message ? e.message : e); resolve([]); });
      proc.on('close', (code) => {
        if (code !== 0 || !out) return resolve([]);
        try {
          const json = JSON.parse(out);
          const entries = Array.isArray(json.entries) ? json.entries : [];
          const items = entries.slice(0, limit).map((e) => {
            const id = e.id || (e.url && e.url.split('v=')[1]) || null;
            const title = e.title || id || 'unknown';
            const url = id ? (`https://www.youtube.com/watch?v=${id}`) : (e.url || null);
            return { title, url };
          }).filter(i => i.url);
          resolve(items);
        } catch (e) { console.error('fetchPlaylistItems parse error:', e && e.message ? e.message : e); resolve([]); }
      });
    } catch (e) { console.error('fetchPlaylistItems error:', e && e.message ? e.message : e); resolve([]); }
  });
}

// Build the controls payload for a given queue
async function fetchImageAsDataURI(url, size = 120) {
  if (!url) return null;
  const MAX_REDIRECTS = 5;
  const MAX_BYTES = 200 * 1024; // 200 KB
  const TIMEOUT_MS = 8000;
  try {
    let cur = url;
    let redirects = 0;
    while (redirects < MAX_REDIRECTS) {
      const u = new URL(cur);
      const http = u.protocol === 'https:' ? require('https') : require('http');
      const res = await new Promise((resolve, reject) => {
        const req = http.get(u, (r) => resolve(r));
        req.on('error', reject);
        req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
      }).catch(() => null);
      if (!res) return null;
      // follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
        cur = new URL(res.headers.location, cur).toString();
        redirects += 1;
        continue;
      }
      // read body with limit
      const chunks = [];
      let received = 0;
      const ok = await new Promise((resolve) => {
        res.on('data', (d) => {
          received += d.length;
          if (received > MAX_BYTES) {
            try { res.destroy(); } catch (e) {}
            return resolve(false);
          }
          chunks.push(d);
        });
        res.on('end', () => resolve(true));
        res.on('error', () => resolve(false));
      });
      if (!ok) return null;
      const buf = Buffer.concat(chunks);
      try {
        if (sharpLib) {
          try {
            const png = await sharpLib(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();
            const base = png.toString('base64');
            return `data:image/png;base64,${base}`;
          } catch (e) {
            // fallback to raw buffer below
          }
        }
        const ct = res.headers['content-type'] || 'image/png';
        const base = buf.toString('base64');
        return `data:${ct};base64,${base}`;
      } catch (e) { return null; }
    }
    return null;
  } catch (e) { return null; }
}

async function buildControlsMessageForQueue(q, guildId) {
  const title = q && q.current ? q.current.title : 'Nessuna traccia in riproduzione';
  const elapsed = q.startedAt ? Math.max(0, Date.now() - q.startedAt) : 0;
  const total = q.currentDuration || 0;

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const pct = total > 0 ? Math.min(1, elapsed / total) : 0;

  // attempt to fetch cover thumbnail as data URI
  let thumbDataUri = null;
  try { thumbDataUri = await fetchImageAsDataURI(q.currentThumbnail); } catch (e) { thumbDataUri = null; }
  // If no thumbnail is available, use a small SVG placeholder that says "Non disponibile"
  if (!thumbDataUri) {
    try {
      const phW = 120;
      const phH = 120;
      const phSvg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns='http://www.w3.org/2000/svg' width='${phW}' height='${phH}'>` +
        `<rect width='100%' height='100%' fill='#1f2937' rx='8'/>` +
        `<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='Arial, Helvetica, sans-serif' font-size='14' fill='#9ca3af'>Non disponibile</text>` +
        `</svg>`;
      thumbDataUri = `data:image/svg+xml;base64,${Buffer.from(phSvg).toString('base64')}`;
    } catch (e) {
      thumbDataUri = null;
    }
  }
  const safeTitle = String(title).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  const width = 450;
  const height = 180;
  const hasThumb = !!thumbDataUri;
  const coverSize = hasThumb ? 120 : 0;
  const contentWidth = width - 40 - coverSize - (hasThumb ? 20 : 0);
  const barWidth = Math.floor(contentWidth * pct);

  const requester = (q.current && q.current.requestedBy) ? String(q.current.requestedBy) : (q.lastRequested && q.lastRequested.requestedBy) || 'N/A';
  // Show position relative to the *current* queue (current + upcoming), ignoring historical played items.
  const totalQueue = ((q.current ? 1 : 0) + (q.songs ? q.songs.length : 0));
  const position = totalQueue > 0 ? 1 : 0;
  const volume = typeof q.volume === 'number' ? Math.round((q.volume || 0.8) * 100) : 80;
  const format = q.currentFormat || 'unknown';
  const bitrate = q.currentBitrate && q.currentBitrate > 0 ? `${q.currentBitrate} kbps` : 'unknown';
  const repeatMode = q && q.repeatMode ? q.repeatMode : 'off';
  const shuffleState = q && q.shuffleEnabled ? 'on' : 'off';

  const svgParts = [];
  svgParts.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
  svgParts.push(`<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'>`);
  svgParts.push(`<rect width='100%' height='100%' fill='#0f172a' rx='12'/>`);
  if (hasThumb) {
    svgParts.push(`<image x='20' y='20' width='${coverSize}' height='${coverSize}' href='${thumbDataUri}' />`);
  }
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='44' font-family='Arial, Helvetica, sans-serif' font-size='20' fill='#ffffff'>${safeTitle}</text>`);
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='68' font-family='Arial, Helvetica, sans-serif' font-size='12' fill='#bfcfe6'>Requester: ${requester} • Posizione: ${position}/${totalQueue}</text>`);
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='88' font-family='Arial, Helvetica, sans-serif' font-size='12' fill='#bfcfe6'>Bitrate: ${bitrate} • Volume: ${volume}%</text>`);
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='106' font-family='Arial, Helvetica, sans-serif' font-size='12' fill='#bfcfe6'>Modalità: Ripeti: ${repeatMode} • Shuffle: ${shuffleState}</text>`);
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='124' font-family='Arial, Helvetica, sans-serif' font-size='12' fill='#bfcfe6'>${total > 0 ? `${fmt(elapsed)} / ${fmt(total)}` : (q && q.current ? '??:??' : '')}</text>`);
  // textual progress bar (20 blocks) using filled/unfilled block characters
  const BAR_BLOCKS = 14;
  const filled = Math.round(pct * BAR_BLOCKS);
  const filledBar = '▰'.repeat(Math.max(0, Math.min(BAR_BLOCKS, filled)));
  const emptyBar = '▱'.repeat(Math.max(0, BAR_BLOCKS - filled));
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='142' font-family='Arial, Helvetica, sans-serif' font-size='18' font-weight='600' fill='#10b981'><tspan fill='#10b981'>${filledBar}</tspan><tspan fill='#334155'>${emptyBar}</tspan><tspan fill='#bfcfe6'> ${Math.round(pct * 100)}%</tspan></text>`);
  svgParts.push(`<text x='20' y='${height - 16}' font-family='Arial, Helvetica, sans-serif' font-size='10' fill='#9ca3af'>DarkChair MusicBot</text>`);
  svgParts.push('</svg>');
  const svg = svgParts.join('\n');

  let file = null;
  let imageName = 'progress.svg';
  if (sharpLib) {
    try {
      const pngBuf = await sharpLib(Buffer.from(svg)).png().toBuffer();
      file = new AttachmentBuilder(pngBuf, { name: 'progress.png' });
      imageName = 'progress.png';
    } catch (e) {
      console.warn('sharp conversion failed, falling back to SVG:', e && e.message ? e.message : e);
      file = new AttachmentBuilder(Buffer.from(svg), { name: 'progress.svg' });
      imageName = 'progress.svg';
    }
  } else {
    file = new AttachmentBuilder(Buffer.from(svg), { name: 'progress.svg' });
    imageName = 'progress.svg';
  }

  const prev = new ButtonBuilder().setCustomId(`prev:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏮️');
  const play = new ButtonBuilder().setCustomId(`play_pause:${guildId}`).setStyle(ButtonStyle.Success).setLabel('⏯️');
  const next = new ButtonBuilder().setCustomId(`next:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏭️');
  const stop = new ButtonBuilder().setCustomId(`stop:${guildId}`).setStyle(ButtonStyle.Danger).setLabel('⏹️');


  // volume controls (separate row to respect max 5 components per row)
  const volDown = new ButtonBuilder().setCustomId(`vol_down:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('🔉');
  const volUp = new ButtonBuilder().setCustomId(`vol_up:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('🔊');
  // repeat and shuffle buttons
  const repeatStyle = (q && q.repeatMode === 'one') ? ButtonStyle.Success : (q && q.repeatMode === 'all') ? ButtonStyle.Primary : ButtonStyle.Secondary;
  const repeatBtn = new ButtonBuilder().setCustomId(`repeat:${guildId}`).setStyle(repeatStyle).setLabel('🔁');
  const shuffleBtn = new ButtonBuilder().setCustomId(`shuffle:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('🔀');

  // First row: navigation + repeat/shuffle (max 5 components)
  const row = new ActionRowBuilder().addComponents(prev, play, next, repeatBtn, shuffleBtn);
  // Second row: stop + volume controls
  const row2 = new ActionRowBuilder().addComponents(stop, volDown, volUp);

  // Keep message text minimal — put title and time only inside the image
  const content = '\u200B';

  return { content, components: [row, row2], files: [file] };
}

// Update the controls message for a guild (if exists)
async function updateControlsMessage(guildId) {
  try {
    const q = queues.get(guildId);
    if (!q || !q.controlsMessage) return;
    const payload = await buildControlsMessageForQueue(q, guildId);
      try {
      // when editing, include files so the attachment image is updated
      await q.controlsMessage.edit({ content: payload.content, components: payload.components, files: payload.files });
    } catch (e) { console.error('Failed to edit controls message:', e && e.message ? e.message : e); }
  } catch (e) { console.error('updateControlsMessage error:', e); }
}

async function ensureConnection(voiceChannel, guildId) {
  let q = queues.get(guildId);
  if (!q) {
    q = createQueue(guildId);
    queues.set(guildId, q);
  }

  if (!q.connection || q.connection.state.status === VoiceConnectionStatus.Destroyed) {
    try {
      q.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });
      q.connection.subscribe(q.player);
      q.connection.on('error', (err) => console.error(`Voice connection error (guild ${guildId}):`, err));
      try { await entersState(q.connection, VoiceConnectionStatus.Ready, 20000); } catch (e) {
        if (e && e.message && e.message.includes('No compatible encryption modes')) {
          console.error('Incompatibilità modalità crittografia SRTP rilevata. Consigli:');
          console.error('- Aggiorna `@discordjs/voice` e `discord.js` all\'ultima versione.');
          console.error('- Installa una libreria sodium per Node (es. `npm install libsodium-wrappers-sumo`).');
          console.error('- Assicurati che la versione dell\'API/adapter del bot sia compatibile con il server Discord.');
        }
        console.warn('Connessione voice non pronta:', e);
      }
    } catch (joinErr) {
      console.error('joinVoiceChannel fallita:', joinErr);
      throw joinErr;
    }
  }
  return q;
}

let _clientReadyHandled = false;
function handleClientReady() {
  if (_clientReadyHandled) return;
  _clientReadyHandled = true;
  console.log(`Logged in as ${client.user.tag}`);
}

// Use the new `clientReady` event (ready is deprecated)
client.once('clientReady', handleClientReady);



client.on('messageCreate', async (message) => {
  // DEBUG: log message arrival for troubleshooting
  try {
    const authorTag = message.author && message.author.tag;
    // Filter out debug logs for these noisy authors so they don't appear in the console
    if (!IGNORED_AUTHORS.includes(authorTag)) {
      console.log('messageCreate:', { author: authorTag, ...message});
    }
  } catch(e){}
  if (message.author.bot) return;
  if (!message.guild) return;
  const tokens = message.content.trim().split(/ +/);
  if (!tokens || tokens.length === 0) return;
  // support both bare commands (e.g. "play song") and prefixed like "/play song"
  let cmdToken = tokens[0];
  if (cmdToken.startsWith('/') || cmdToken.startsWith('!')) cmdToken = cmdToken.slice(1);
  const cmd = cmdToken.toLowerCase();
  const args = tokens.slice(1);
    const valid = new Set(['play','p','skip','stop','queue','q','np','replay','r','controls','c','playplaylist','pp','playlast','pllast','listplaylists','lpl','web','help']);
  if (!valid.has(cmd)) return;
  console.log(`Command received from ${message.author.tag}: ${message.content}`);

  // Helper: build the controls message for this guild
  function buildControlsMessage(guildId) {
    const q = queues.get(guildId);
    const title = q && q.current ? q.current.title : 'Nessuna traccia in riproduzione';

    const prev = new ButtonBuilder().setCustomId(`prev:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏮️');
    const play = new ButtonBuilder().setCustomId(`play_pause:${guildId}`).setStyle(ButtonStyle.Success).setLabel('⏯️');
    const next = new ButtonBuilder().setCustomId(`next:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏭️');
    const stop = new ButtonBuilder().setCustomId(`stop:${guildId}`).setStyle(ButtonStyle.Danger).setLabel('⏹️');
    //const progress = new ButtonBuilder().setCustomId(`progress:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('Progress');

    const repeatStyle = (q && q.repeatOne) ? ButtonStyle.Success : ButtonStyle.Secondary;
    const repeatBtn = new ButtonBuilder().setCustomId(`repeat:${guildId}`).setStyle(repeatStyle).setLabel('🔁');
    const shuffleBtn = new ButtonBuilder().setCustomId(`shuffle:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('🔀');

    // First row: navigation + repeat/shuffle
    const row = new ActionRowBuilder().addComponents(prev, play, next, repeatBtn, shuffleBtn);
    // Second row: stop alone (no volume controls in this simplified controls builder)
    const row2 = new ActionRowBuilder().addComponents(stop);
    // keep the message text minimal so title/time live only inside the image
    const content = '\u200B';
    return { content, components: [row, row2] };
  }

  if (cmd === 'play' || cmd === 'p') {
    const query = args.join(' ');
    if (!query) { await replyAndDelete(message, 'Usage: ' + PREFIX + 'play <YouTube URL or search terms>'); return; }
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) { await replyAndDelete(message, 'Devi essere in un canale vocale.'); return; }

    let url = query;
    if (!/^https?:\/\//i.test(url)) {
      const search = await yts(query);
      const first = search && search.videos && search.videos.length ? search.videos[0] : null;
      if (!first) { await replyAndDelete(message, 'Nessun risultato per: ' + query); return; }
      url = first.url;
    }

    const isPlaylist = /[?&]list=/.test(url) || /playlist\?list=/i.test(url) || /youtu\.be\/.*[?&]list=/.test(url);

    try {
      const q = await ensureConnection(voiceChannel, message.guild.id);
      // remember the text channel where the user requested playback for controls messages
      try { q.controlChannelId = message.channel && message.channel.id; } catch (e) {}
      if (isPlaylist) {
        const items = await fetchPlaylistItems(url, 100);
        if (!items || items.length === 0) { await replyAndDelete(message, 'Nessun elemento trovato nella playlist.'); return; }
        // persist the fetched playlist to disk so it can be replayed later
        let fname = null;
        try {
          const dir = guildPlaylistsDir(message.guild.id);
          fname = `playlist_${Date.now()}.json`;
          const fpath = path.join(dir, fname);
          fs.writeFileSync(fpath, JSON.stringify(items, null, 2), 'utf8');
          console.log('Saved playlist to', fpath);
          // push items with origin metadata referencing the saved playlist file
          items.forEach((it, idx) => q.songs.push({ title: it.title, url: it.url, requestedBy: message.author.username, originPlaylist: fname, originIndex: idx + 1 }));
          // inform the user about saved playlist file
          await replyAndDeleteAndMaybeRemoveTrigger(message, `Aggiunta ${items.length} brani dalla playlist: **${items[0].title}** (salvata come ${fname})`, 10000, true);
        } catch (e) {
          console.error('Failed to save playlist file:', e);
          // even if saving fails, push items without origin metadata so playback continues
          items.forEach((it) => q.songs.push({ title: it.title, url: it.url, requestedBy: message.author.username }));
          await replyAndDeleteAndMaybeRemoveTrigger(message, `Aggiunta ${items.length} brani dalla playlist: **${items[0].title}** (impossibile salvare su file)`, 10000, true);
        }
        // Remember last requested as first item
        q.lastRequested = { title: items[0].title, url: items[0].url, requestedBy: message.author.username };
        try { lastTracks[message.guild.id] = q.lastRequested; saveLastTracks(); } catch (e) { console.error('Failed to persist lastRequested for guild', message.guild.id, e && e.message ? e.message : e); }
        // reply already sent above after attempting to save
        // send controls immediately in the channel where play was requested
        try {
          if (!q.controlsMessage && q.controlChannelId) {
            const ch = await client.channels.fetch(q.controlChannelId).catch(() => null);
            if (ch && typeof ch.send === 'function') {
                  const payload = await buildControlsMessageForQueue(q, message.guild.id);
                  const sent = await ch.send(payload).catch(() => null);
              if (sent) {
                q.controlsMessage = sent;
                try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
                q.controlsInterval = setInterval(() => updateControlsMessage(message.guild.id), 5000);
              }
            }
          }
        } catch (e) { console.error('send controls on play (playlist) error', e); }

        if (!q.playing) playNext(message.guild.id);
        return;
      }

      const info = await yt.getInfo(url);
      const title = info ? (info.title || info.fulltitle || url) : url;

      q.songs.push({ title, url, requestedBy: message.author.username });
      // Remember last requested track for this guild
      q.lastRequested = { title, url, requestedBy: message.author.username };
      try {
        lastTracks[message.guild.id] = q.lastRequested;
        saveLastTracks();
      } catch (e) {
        console.error('Failed to persist lastRequested for guild', message.guild.id, e && e.message ? e.message : e);
      }
      await replyAndDeleteAndMaybeRemoveTrigger(message, `Aggiunto in coda: **${title}**`, 10000, true);
      // send controls immediately in the channel where play was requested
      try {
        if (!q.controlsMessage && q.controlChannelId) {
          const ch = await client.channels.fetch(q.controlChannelId).catch(() => null);
          if (ch && typeof ch.send === 'function') {
                const payload = await buildControlsMessageForQueue(q, message.guild.id);
                const sent = await ch.send(payload).catch(() => null);
            if (sent) {
              q.controlsMessage = sent;
              try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
              q.controlsInterval = setInterval(() => updateControlsMessage(message.guild.id), 5000);
            }
          }
        }
      } catch (e) { console.error('send controls on play error', e); }

      if (!q.playing) playNext(message.guild.id);
    } catch (connErr) {
      console.error('Errore connessione voice in play command:', connErr);
      await replyAndDelete(message, 'Impossibile connettersi al canale vocale. Controlla i log per dettagli.');
    }
  }

  if (cmd === 'controls' || cmd === 'c') {
    try {
      const q = queues.get(message.guild.id) || createQueue(message.guild.id);
      queues.set(message.guild.id, q);
      const payload = await buildControlsMessageForQueue(q, message.guild.id);
      const sent = await message.channel.send(payload);
      // store reference and start interval updater
      q.controlsMessage = sent;
      try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
      q.controlsInterval = setInterval(() => updateControlsMessage(message.guild.id), 5000);
      await replyAndDeleteAndMaybeRemoveTrigger(message, 'Pannello di controllo inviato.', 10000, true);
    } catch (e) {
      console.error('Errore invio pannello controlli:', e);
      await replyAndDelete(message, 'Impossibile inviare il pannello di controllo.');
    }
  }

  if (cmd === 'replay' || cmd === 'r') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) { await replyAndDelete(message, 'Devi essere in un canale vocale per riprodurre l\'ultimo brano.'); return; }
    try {
      const q = await ensureConnection(voiceChannel, message.guild.id);
      // remember channel for controls
      try { q.controlChannelId = message.channel && message.channel.id; } catch (e) {}
      if (!q.lastRequested) { await replyAndDelete(message, 'Nessun brano memorizzato da riprodurre.'); return; }
      const { title, url } = q.lastRequested;
      q.songs.push({ title, url, requestedBy: message.author.username });
      await replyAndDeleteAndMaybeRemoveTrigger(message, `Riproduco l'ultimo brano memorizzato: **${title}**`, 10000, true);
      // ensure controls are posted
      try {
        if (!q.controlsMessage && q.controlChannelId) {
          const ch = await client.channels.fetch(q.controlChannelId).catch(() => null);
          if (ch && typeof ch.send === 'function') {
            const payload = await buildControlsMessageForQueue(q, message.guild.id);
            const sent = await ch.send(payload).catch(() => null);
            if (sent) {
              q.controlsMessage = sent;
              try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
              q.controlsInterval = setInterval(() => updateControlsMessage(message.guild.id), 5000);
            }
          }
        }
      } catch (e) { console.error('send controls on replay error', e); }
      if (!q.playing) playNext(message.guild.id);
    } catch (e) {
      console.error('Errore replay:', e);
      await replyAndDelete(message, 'Impossibile riprodurre l\'ultimo brano.');
    }
  }

  if (cmd === 'listplaylists' || cmd === 'lpl') {
    try {
      const dir = guildPlaylistsDir(message.guild.id);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
      if (!files || files.length === 0) {
        await replyAndDelete(message, 'Nessuna playlist salvata.');
        return;
      }
      // Build up to 25 buttons (Discord max 5 per row, 5 rows)
      const maxButtons = Math.min(files.length, 25);
      const rows = [];
      for (let i = 0; i < maxButtons; i += 5) {
        const slice = files.slice(i, i + 5);
        const components = slice.map((fname) => new ButtonBuilder().setCustomId(`ppfile:${message.guild.id}:${fname}`).setLabel(fname).setStyle(ButtonStyle.Primary));
        const row = new ActionRowBuilder().addComponents(...components);
        rows.push(row);
      }
      // Send the playlist buttons in-channel and delete after 30s so they're not permanently visible
      try {
        const sent = await message.channel.send({ content: 'Seleziona una playlist per riprodurla:', components: rows }).catch(() => null);
        if (sent) setTimeout(() => { try { sent.delete().catch(() => {}); } catch (e) {} }, 30000);
        await replyAndDeleteAndMaybeRemoveTrigger(message, 'Playlist inviate (scompariranno dopo 30s).', 10000, true);
      } catch (e) {
        console.error('Failed to send playlist buttons in channel:', e);
        await replyAndDeleteAndMaybeRemoveTrigger(message, 'Errore nell\'invio delle playlist.', 10000, true);
      }
    } catch (e) {
      console.error('listplaylists error', e);
      await replyAndDelete(message, 'Errore nel leggere le playlist salvate.');
    }
    return;
  }

  if (cmd === 'help') {
    try {
      const helpText = `Comandi disponibili:
    • play <url|terms> / p — riproduce o mette in coda una traccia
    • playplaylist <filename> / pp — riproduce una playlist salvata
    • playlast / pllast — riproduce l'ultima playlist salvata
    • listplaylists / lpl — mostra le playlist salvate
    • skip — salta traccia
    • stop — ferma riproduzione e svuota coda
    • queue / q — mostra la coda
    • np — mostra la traccia attuale
    • replay / r — riproduce l'ultimo brano memorizzato
    • controls / c — invia pannello controlli
    • web — crea una pagina web temporanea per gestire il server
    • help — mostra questo aiuto`;
      await replyAndDeleteAndMaybeRemoveTrigger(message, helpText, 20000, false);
    } catch (e) { console.error('help command error', e); }
    return;
  }

  if (cmd === 'web') {
    // create a temporary web session token and reply URL
    try {
      if (!message.guild) return await replyAndDelete(message, 'Questo comando deve essere usato in un server.');
      const token = createWebSession(message.guild.id, message.author.id, 1000 * 60 * 60); // 1h
      const port = parseInt(process.env.WEB_PORT || '3002', 10);
      const base = process.env.WEB_BASE_URL || `http://darknio.ovh:${port}`;
      const url = `${base.replace(/\/$/, '')}/user/${token}`;
      await replyAndDeleteAndMaybeRemoveTrigger(message, `Pagina web creata: ${url}`, 20000, false);
    } catch (e) {
      console.error('web command error', e);
      await replyAndDelete(message, 'Errore durante la creazione della pagina web.');
    }
    return;
  }

  if (cmd === 'playplaylist' || cmd === 'pp') {
    const fname = args[0];
    if (!fname) { await replyAndDelete(message, `Usage: ${PREFIX}playplaylist <filename>`); return; }
    const fpath = path.join(guildPlaylistsDir(message.guild.id), fname);
    if (!fs.existsSync(fpath)) { await replyAndDelete(message, `File non trovato: ${fname}`); return; }
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) { await replyAndDelete(message, 'Devi essere in un canale vocale.'); return; }
    try {
      const q = await ensureConnection(voiceChannel, message.guild.id);
      // remember control channel
      try { q.controlChannelId = message.channel && message.channel.id; } catch (e) {}
      const raw = fs.readFileSync(fpath, 'utf8');
      const items = JSON.parse(raw);
      if (!Array.isArray(items) || items.length === 0) { await replyAndDelete(message, 'Playlist vuota o file non valido.'); return; }
      items.forEach((it, idx) => q.songs.push({ title: it.title, url: it.url, requestedBy: message.author.username, originPlaylist: fname, originIndex: idx + 1 }));
      q.lastRequested = { title: items[0].title, url: items[0].url, requestedBy: message.author.username };
      try { lastTracks[message.guild.id] = q.lastRequested; saveLastTracks(); } catch (e) {}
      await replyAndDeleteAndMaybeRemoveTrigger(message, `Aggiunta ${items.length} brani dalla playlist file: **${fname}**`, 10000, true);
      // send controls immediately
      try {
        if (!q.controlsMessage && q.controlChannelId) {
          const ch = await client.channels.fetch(q.controlChannelId).catch(() => null);
          if (ch && typeof ch.send === 'function') {
            const payload = await buildControlsMessageForQueue(q, message.guild.id);
            const sent = await ch.send(payload).catch(() => null);
            if (sent) {
              q.controlsMessage = sent;
              try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
              q.controlsInterval = setInterval(() => updateControlsMessage(message.guild.id), 5000);
            }
          }
        }
      } catch (e) { console.error('send controls on playplaylist error', e); }
      if (!q.playing) playNext(message.guild.id);
    } catch (e) {
      console.error('playplaylist error', e);
      await replyAndDelete(message, 'Impossibile riprodurre la playlist dal file.');
    }
    return;
  }

  if (cmd === 'playlast' || cmd === 'pllast') {
    try {
      const dir = guildPlaylistsDir(message.guild.id);
      // if a playlist is marked as currently selected by the web UI (persisted in settings), prefer it
      const cur = settings[message.guild.id] && settings[message.guild.id].currentPlaylist ? settings[message.guild.id].currentPlaylist : null;
      let latest = null;
      if (cur) {
        const curPath = path.join(dir, cur);
        if (fs.existsSync(curPath)) {
          latest = cur;
        }
      }
      if (!latest) {
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
        if (!files || files.length === 0) { await replyAndDelete(message, 'Nessuna playlist salvata.'); return; }
        // pick most recently modified file
        let latestM = 0;
        files.forEach((f) => {
          try {
            const st = fs.statSync(path.join(dir, f));
            const m = st && st.mtimeMs ? st.mtimeMs : 0;
            if (!latest || m > latestM) { latest = f; latestM = m; }
          } catch (e) {}
        });
        if (!latest) { await replyAndDelete(message, 'Impossibile determinare l\'ultima playlist.'); return; }
      }
      const fpath = path.join(dir, latest);
      if (!fs.existsSync(fpath)) { await replyAndDelete(message, `File non trovato: ${latest}`); return; }
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) { await replyAndDelete(message, 'Devi essere in un canale vocale.'); return; }
      const q = await ensureConnection(voiceChannel, message.guild.id);
      try { q.controlChannelId = message.channel && message.channel.id; } catch (e) {}
      const raw = fs.readFileSync(fpath, 'utf8');
      const items = JSON.parse(raw);
      if (!Array.isArray(items) || items.length === 0) { await replyAndDelete(message, 'Playlist vuota o file non valido.'); return; }
      items.forEach((it, idx) => q.songs.push({ title: it.title, url: it.url, requestedBy: message.author.username, originPlaylist: latest, originIndex: idx + 1 }));
      q.lastRequested = { title: items[0].title, url: items[0].url, requestedBy: message.author.username };
      try { lastTracks[message.guild.id] = q.lastRequested; saveLastTracks(); } catch (e) {}
      await replyAndDeleteAndMaybeRemoveTrigger(message, `Aggiunta ${items.length} brani dalla playlist: **${latest}**`, 10000, true);
      // send controls immediately
      try {
        if (!q.controlsMessage && q.controlChannelId) {
          const ch = await client.channels.fetch(q.controlChannelId).catch(() => null);
          if (ch && typeof ch.send === 'function') {
            const payload = await buildControlsMessageForQueue(q, message.guild.id);
            const sent = await ch.send(payload).catch(() => null);
            if (sent) {
              q.controlsMessage = sent;
              try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
              q.controlsInterval = setInterval(() => updateControlsMessage(message.guild.id), 5000);
            }
          }
        }
      } catch (e) { console.error('send controls on playlast error', e); }
      if (!q.playing) playNext(message.guild.id);
    } catch (e) {
      console.error('playlast error', e);
      await replyAndDelete(message, 'Impossibile riprodurre l\'ultima playlist.');
    }
    return;
  }

  if (cmd === 'skip') {
    const q = queues.get(message.guild.id);
    if (!q) { await replyAndDelete(message, 'Nessuna musica in riproduzione.'); return; }
    // force skip even if repeatMode === 'one'
    try { q._forceSkipOnce = true; } catch (e) {}
    q.player.stop();
    await replyAndDeleteAndMaybeRemoveTrigger(message, 'Brano saltato.', 10000, true);
  }

  if (cmd === 'stop') {
    const q = queues.get(message.guild.id);
    if (!q) { await replyAndDelete(message, 'Nessuna musica in riproduzione.'); return; }
    try { q.songs = []; q.player.stop(); if (q.connection) q.connection.destroy(); } catch (e) { console.error('Stop error:', e); }
    queues.delete(message.guild.id);
    await replyAndDeleteAndMaybeRemoveTrigger(message, 'Riproduzione fermata e coda svuotata.', 10000, true);
  }

  if (cmd === 'queue' || cmd === 'q') {
    const q = queues.get(message.guild.id);
    if (!q || (!q.current && q.songs.length === 0)) { await replyAndDelete(message, 'Coda vuota.'); return; }
    const lines = [];
    if (q.current) lines.push(`Now playing: ${q.current.title}`);
    q.songs.slice(0, 10).forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
    await replyAndDeleteAndMaybeRemoveTrigger(message, lines.join('\n'), 10000, true);
  }

  if (cmd === 'np') {
    const q = queues.get(message.guild.id);
    if (!q || !q.current) { await replyAndDelete(message, 'Nessuna traccia in riproduzione.'); return; }
    await replyAndDeleteAndMaybeRemoveTrigger(message, `Now playing: ${q.current.title}`, 10000, true);
  }
});

// Handle button interactions for playback controls
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const parts = interaction.customId.split(':');
    const action = parts[0];
    const guildId = parts[1];
    const rest = parts.slice(2).join(':');
    // acknowledge silently (no ephemeral visible message)
    await interaction.deferUpdate().catch(() => {});
    // canonical guild id for this interaction (may come from customId or interaction.guild)
    const gid = interaction.guildId || guildId;
    // Make interaction.reply safe after a defer: if reply is attempted after defer/replied,
    // route it to followUp({ ephemeral: true }) to avoid InteractionAlreadyReplied errors.
    try {
      const _origReply = interaction.reply.bind(interaction);
      interaction.reply = async (opts) => {
        try {
          if (interaction.replied || interaction.deferred) {
            const safeOpts = (typeof opts === 'string') ? { content: opts, ephemeral: true } : Object.assign({}, opts, { ephemeral: true });
            return await interaction.followUp(safeOpts);
          }
          return await _origReply(opts);
        } catch (e) {
          try { return await interaction.followUp({ content: typeof opts === 'string' ? opts : (opts && opts.content) || ' ', ephemeral: true }); } catch (e2) { /* swallow */ }
        }
      };
    } catch (e) {}

    // Handle playlist-file button: ppfile:<guildId>:<filename>
    if (action === 'ppfile') {
      const fname = rest;
      try {
          const gid = interaction.guildId || guildId;
          const fpath = path.join(guildPlaylistsDir(gid), fname);
          if (!fs.existsSync(fpath)) return interaction.followUp({ content: `File non trovato: ${fname}`, ephemeral: true });
        const voiceChannel = interaction.member && interaction.member.voice && interaction.member.voice.channel;
        if (!voiceChannel) return interaction.followUp({ content: 'Devi essere in un canale vocale per riprodurre la playlist.', ephemeral: true });
          const q = await ensureConnection(voiceChannel, interaction.guildId || guildId);
        try { q.controlChannelId = interaction.channelId || q.controlChannelId; } catch (e) {}
        const raw = fs.readFileSync(fpath, 'utf8');
        const items = JSON.parse(raw);
        if (!Array.isArray(items) || items.length === 0) return interaction.followUp({ content: 'Playlist vuota o file non valido.', ephemeral: true });
        items.forEach((it, idx) => q.songs.push({ title: it.title, url: it.url, requestedBy: interaction.user.username, originPlaylist: fname, originIndex: idx + 1 }));
        q.lastRequested = { title: items[0].title, url: items[0].url, requestedBy: interaction.user.username, originPlaylist: fname, originIndex: 1 };
        try { lastTracks[interaction.guildId || guildId] = q.lastRequested; saveLastTracks(); } catch (e) {}
        // send controls immediately if not present
        try {
          if (!q.controlsMessage && q.controlChannelId) {
            const ch = await client.channels.fetch(q.controlChannelId).catch(() => null);
            if (ch && typeof ch.send === 'function') {
              const payload = await buildControlsMessageForQueue(q, interaction.guildId || guildId);
              const sent = await ch.send(payload).catch(() => null);
              if (sent) {
                q.controlsMessage = sent;
                try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
                q.controlsInterval = setInterval(() => updateControlsMessage(interaction.guildId || guildId), 5000);
              }
            }
          }
        } catch (e) { console.error('send controls on ppfile error', e); }
        if (!q.playing) playNext(interaction.guildId || guildId);
        return interaction.followUp({ content: `Aggiunta ${items.length} brani dalla playlist: **${fname}**`, ephemeral: true });
      } catch (e) {
        console.error('ppfile handling error', e);
        return interaction.followUp({ content: 'Errore nel riprodurre la playlist selezionata.', ephemeral: true });
      }
    }

    const q = queues.get(interaction.guildId || guildId);
    if (!q) return interaction.followUp({ content: 'Nessuna riproduzione attiva.', ephemeral: true });

    if (action === 'play_pause') {
      try {
        if (q.player.state.status === AudioPlayerStatus.Playing) {
          q.player.pause();
        } else {
          q.player.unpause();
        }
        // update controls message after action
        updateControlsMessage(interaction.guildId || guildId);
      } catch (e) { console.error('play_pause error', e); await interaction.followUp({ content: 'Errore play/pause', ephemeral: true }); }
      return;
    }

    if (action === 'next') {
      try { q._forceSkipOnce = true; q.player.stop(); updateControlsMessage(gid); } catch (e) { console.error(e); }
      return;
    }

    if (action === 'shuffle') {
      try {
        if (!q) return;
        // Toggle persistent shuffle mode for this guild. When enabling, randomize the remaining queue.
        q.shuffleEnabled = !!q.shuffleEnabled ? false : true;
        if (q.shuffleEnabled && q.songs && q.songs.length > 1) {
          // Fisher-Yates shuffle of q.songs
          for (let i = q.songs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = q.songs[i]; q.songs[i] = q.songs[j]; q.songs[j] = tmp;
          }
        }
        // persist preference
        try {
          settings[gid] = settings[gid] || {};
          settings[gid].shuffle = !!q.shuffleEnabled;
          saveSettings();
        } catch (e) { console.error('Failed to persist shuffle setting', e); }
        // force next track if shuffle moved something to front
        try { q._forceSkipOnce = true; q.player.stop(); } catch (e) {}
        updateControlsMessage(gid);
      } catch (e) { console.error('shuffle error', e); }
      return;
    }

    if (action === 'repeat') {
      try {
        if (!q) return;
        // cycle repeatMode: off -> one -> all -> off
        if (q.repeatMode === 'off') q.repeatMode = 'one';
        else if (q.repeatMode === 'one') q.repeatMode = 'all';
        else q.repeatMode = 'off';
        // persist preference
        try {
          settings[gid] = settings[gid] || {};
          settings[gid].repeatMode = q.repeatMode;
          saveSettings();
        } catch (e) { console.error('Failed to persist repeat setting', e); }
        updateControlsMessage(gid);
      } catch (e) { console.error('repeat toggle error', e); }
      return;
    }

    if (action === 'prev') {
      try {
        if (!q.history || q.history.length === 0) return interaction.followUp({ content: 'Nessuna traccia precedente.', ephemeral: true });
        const prev = q.history.pop();
        q.songs.unshift(prev);
        try { q._forceSkipOnce = true; } catch (e) {}
        q.player.stop();
        updateControlsMessage(gid);
      } catch (e) { console.error('prev error', e); await interaction.followUp({ content: 'Errore previous', ephemeral: true }); }
      return;
    }

    if (action === 'stop') {
      try {
        q.songs = []; q.player.stop(); if (q.connection) q.connection.destroy();
        try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
        try { if (q.controlsMessage) q.controlsMessage.delete().catch(()=>{}); } catch (e) {}
        queues.delete(interaction.guildId || guildId);
      } catch (e) { console.error('stop error', e); await interaction.followUp({ content: 'Errore stop', ephemeral: true }); }
      return;
    }

    if (action === 'vol_up' || action === 'vol_down') {
      try {
        const delta = action === 'vol_up' ? 0.05 : -0.05;
        q.volume = (typeof q.volume === 'number' ? q.volume : 0.8) + delta;
        if (q.volume < 0) q.volume = 0;
        if (q.volume > 2) q.volume = 2;
        // apply to currently playing resource if possible
        try {
          const res = q.player && q.player.state && q.player.state.resource;
          if (res && res.volume && typeof res.volume.setVolume === 'function') {
            res.volume.setVolume(q.volume);
          }
        } catch (e) {}
        // persist volume
        try {
          settings[gid] = settings[gid] || {};
          settings[gid].volume = q.volume;
          saveSettings();
        } catch (e) { console.error('Failed to persist volume setting', e); }
        // volume changed silently
        updateControlsMessage(gid);
      } catch (e) { console.error('volume change error', e); await interaction.followUp({ content: 'Errore volume', ephemeral: true }); }
      return;
    }

    
  } catch (e) {
    console.error('interactionCreate handler error:', e);
  }
});

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

// Better login flow: await with timeout, prefer env token, and add error handlers
client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('Discord shard error:', e));
client.on('warn', (m) => console.warn('Discord warn:', m));

(async () => {
  const tokenToUse = TOKEN;
  const loginTimeoutMs = parseInt(process.env.CLIENT_LOGIN_TIMEOUT_MS || '30000', 10);
  try {
    const loginPromise = client.login(tokenToUse);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('client.login timeout')), loginTimeoutMs));
    await Promise.race([loginPromise, timeoutPromise]);
    console.log('client.login resolved');
  } catch (e) {
    console.error('client.login failed:', e && e.message ? e.message : e);
    // keep process alive for debugging; optionally exit if desired
  }
})();
// Start auth-server (express + puppeteer) to allow remote YouTube login/export of cookies

  try {
    const api = require('darkchair_api_youtube');
    const authPort = process.env.AUTH_PORT || 3001;
    // startAuthServer returns a Promise that resolves with the server — run async and don't block bot startup
    if (api && typeof api.startAuthServer === 'function') {
      (async () => {
        try {
          await api.startAuthServer(authPort);
          console.log(`auth-server listening on ${authPort}`);
        } catch (e) {
          console.error('Failed to start auth-server (async):', e && e.message ? e.message : e);
        }
      })();
    } else {
      console.log('auth-server module does not export startAuthServer(); skipping async start.');
    }
  } catch (e) {
    console.error('Failed to start auth-server:', e && e.message ? e.message : e);
  }

// --- Web management interface (simple) ----------------------------------
try {
  const express = require('express');
  const cors = require('cors');
  const app = express();
  const WEB_PORT = parseInt(process.env.WEB_PORT || '3002', 10);
  app.use(cors());
  app.use(express.json());
  const webRoot = path.join(process.cwd(), 'web');
  app.use(express.static(webRoot));

  // Optional simple secret header to limit access (set WEB_SECRET env)
  function checkSecret(req, res, next) {
    const secret = process.env.WEB_SECRET || null;
    // allow if global secret matches
    if (secret) {
      const got = req.headers['x-web-secret'] || req.query.secret;
      if (got === secret) return next();
    } else {
      // if no global secret set we allow anonymous access (existing behavior)
      // but still allow token-based sessions below
    }
    // allow token-based session auth via header or query param
    const token = req.headers['x-web-token'] || req.query.token;
    if (token && webSessions.has(token)) {
      const s = webSessions.get(token);
      // expire check
      if (s.expires && s.expires < Date.now()) { webSessions.delete(token); return res.status(401).json({ error: 'session_expired' }); }
      // if route is guild-scoped, ensure token.guild matches requested guild
      const gid = req.params && req.params.id ? String(req.params.id) : null;
      if (gid && s.guild && String(s.guild) !== String(gid)) return res.status(403).json({ error: 'forbidden' });
      // attach session to request for auditing
      req.webSession = s;
      return next();
    }
    if (!secret) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }

  app.get('/api/guilds', checkSecret, (req, res) => {
    try {
      const list = client.guilds.cache.map((g) => ({ id: g.id, name: g.name }));
      return res.json(list);
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // create a web session token for a guild (can be called by bot or external)
  app.post('/api/guild/:id/websession', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const user = req.body && req.body.user ? String(req.body.user) : (req.webSession && req.webSession.user) || 'web';
      const ttl = req.body && req.body.ttl ? parseInt(req.body.ttl, 10) : (60 * 60 * 1000);
      const admin = req.body && req.body.admin ? true : false;
      const token = createWebSession(gid, user, ttl, admin);
      return res.json({ ok: true, token, expires: Date.now() + ttl });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // inspect a web session token (returns session info if token valid)
  app.get('/api/websession/:token', (req, res) => {
    try {
      const token = req.params.token;
      if (!token || !webSessions.has(token)) return res.status(404).json({ error: 'not_found' });
      const s = webSessions.get(token);
      if (s.expires && s.expires < Date.now()) { webSessions.delete(token); return res.status(410).json({ error: 'expired' }); }
      return res.json({ ok: true, guild: s.guild, user: s.user, admin: !!s.admin, expires: s.expires });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // user-facing page: /user/:token -> redirects to main UI carrying token and guild
  app.get('/user/:token', (req, res) => {
    try {
      const token = req.params.token;
      if (!token || !webSessions.has(token)) return res.status(404).send('Session not found or expired');
      const s = webSessions.get(token);
      const WEB_PORT = parseInt(process.env.WEB_PORT || '3002', 10);
      const WEB_HOST = process.env.WEB_BASE_URL || (`http://darknio.ovh:${WEB_PORT}`);
      // redirect to user-specific page with token and guild as query params
      return res.redirect(`${WEB_HOST.replace(/\/$/, '')}/user.html?token=${encodeURIComponent(token)}&guild=${encodeURIComponent(s.guild)}`);
    } catch (e) { return res.status(500).send('Server error'); }
  });

  app.get('/api/guild/:id/status', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const g = client.guilds.cache.get(gid);
      const q = queues.get(gid);
      const result = {
        guild: g ? { id: g.id, name: g.name } : null,
        connected: !!q && !!q.connection,
        playing: q ? !!q.playing : false,
        current: q && q.current ? { title: q.current.title, url: q.current.url, requestedBy: q.current.requestedBy } : null,
        queue: q && q.songs ? q.songs.slice(0, 50).map(s => ({ title: s.title, url: s.url, requestedBy: s.requestedBy })) : [],
        // volume: prefer current queue volume; if not present, fall back to persisted settings
        volume: (q && typeof q.volume === 'number') ? q.volume : (settings[gid] && typeof settings[gid].volume === 'number' ? settings[gid].volume : null),
        repeatMode: q ? q.repeatMode : null,
        shuffle: q ? !!q.shuffleEnabled : false,
        historyLength: q && q.history ? q.history.length : 0,
        controlChannelId: q ? q.controlChannelId : null,
        currentDuration: q ? q.currentDuration : 0,
        startedAt: q ? q.startedAt : null,
      };
      return res.json(result);
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // list text-capable channels for a guild (useful for "Invia messaggio")
  app.get('/api/guild/:id/channels', checkSecret, async (req, res) => {
    try {
      const gid = req.params.id;
      const guild = client.guilds.cache.get(gid);
      if (!guild) return res.status(404).json({ error: 'guild_not_found' });
      const out = [];
      try {
        const fetched = await guild.channels.fetch();
        fetched.forEach((c) => {
          try {
            const isText = (typeof c.isTextBased === 'function') ? c.isTextBased() : (c.type === 0);
            if (isText && c.id) out.push({ id: c.id, name: c.name || (c.topic || ''), type: c.type });
          } catch (e) {}
        });
      } catch (e) {
        // fallback to cache-only
        guild.channels.cache.forEach((c) => {
          try {
            const isText = (typeof c.isTextBased === 'function') ? c.isTextBased() : (c.type === 0);
            if (isText && c.id) out.push({ id: c.id, name: c.name || (c.topic || ''), type: c.type });
          } catch (e) {}
        });
      }
      return res.json(out);
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/skip', checkSecret, (req, res) => {
    try {
      const q = queues.get(req.params.id);
      if (!q) return res.status(400).json({ error: 'no_queue' });
      q._forceSkipOnce = true;
      try { q.player.stop(); } catch (e) {}
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/pause', checkSecret, (req, res) => {
    try { const q = queues.get(req.params.id); if (!q) return res.status(400).json({ error: 'no_queue' }); q.player.pause(); return res.json({ ok: true }); } catch (e) { return res.status(500).json({ error: String(e) }); }
  });
  app.post('/api/guild/:id/resume', checkSecret, (req, res) => {
    try { const q = queues.get(req.params.id); if (!q) return res.status(400).json({ error: 'no_queue' }); q.player.unpause(); return res.json({ ok: true }); } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/stop', checkSecret, (req, res) => {
    try {
      const q = queues.get(req.params.id);
      if (!q) return res.status(400).json({ error: 'no_queue' });
      try { q.songs = []; q.player.stop(); if (q.connection) q.connection.destroy(); } catch (e) {}
      queues.delete(req.params.id);
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/volume', checkSecret, (req, res) => {
    try {
      const v = parseFloat(req.body.volume);
      if (isNaN(v)) return res.status(400).json({ error: 'invalid_volume' });
      const q = queues.get(req.params.id);
      if (!q) return res.status(400).json({ error: 'no_queue' });
      q.volume = v;
      try { const resrc = q.player && q.player.state && q.player.state.resource; if (resrc && resrc.volume && typeof resrc.volume.setVolume === 'function') resrc.volume.setVolume(q.volume); } catch (e) {}
      try { settings[req.params.id] = settings[req.params.id] || {}; settings[req.params.id].volume = q.volume; saveSettings(); } catch (e) {}
      return res.json({ ok: true, volume: q.volume });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // list saved playlist files for a guild
  app.get('/api/guild/:id/playlists', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const dir = guildPlaylistsDir(gid);
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      return res.json(files);
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // get/set the "current" playlist selected in the web UI for a guild
  app.get('/api/guild/:id/currentPlaylist', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const cur = settings[gid] && settings[gid].currentPlaylist ? settings[gid].currentPlaylist : null;
      return res.json({ ok: true, filename: cur });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/currentPlaylist', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.body && req.body.filename ? String(req.body.filename) : null;
      if (!fname) return res.status(400).json({ error: 'missing_filename' });
      // validate filename
      if (fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      // ensure file exists
      const dir = guildPlaylistsDir(gid);
      const fpath = path.join(dir, fname);
      if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'file_not_found' });
      settings[gid] = settings[gid] || {};
      settings[gid].currentPlaylist = fname;
      saveSettings();
      return res.json({ ok: true, filename: fname });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // read playlist file content
  app.get('/api/guild/:id/playlists/:filename', checkSecret, (req, res, next) => {
    try {
      const gid = req.params.id;
      const fname = req.params.filename;
      // if the filename equals the special keyword 'trash', forward to next route (so /playlists/trash works)
      if (fname === 'trash') return next();
      if (!fname || fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      const dir = guildPlaylistsDir(gid);
      const fpath = path.join(dir, fname);
      if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not_found' });
      const raw = fs.readFileSync(fpath, 'utf8');
      const items = JSON.parse(raw);
      return res.json({ filename: fname, items });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // list trashed playlist files for a guild
  app.get('/api/guild/:id/playlists/trash', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const dir = guildTrashDir(gid);
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      return res.json(files);
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // restore a trashed playlist back to playlists dir
  app.post('/api/guild/:id/playlists/trash/restore', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.body && req.body.filename ? String(req.body.filename) : null;
      if (!fname) return res.status(400).json({ error: 'missing_filename' });
      if (fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      const trashDir = guildTrashDir(gid);
      const src = path.join(trashDir, fname);
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'not_found' });
      const dir = guildPlaylistsDir(gid);
      let dest = path.join(dir, fname);
      if (fs.existsSync(dest)) {
        const ts = Date.now();
        const ext = path.extname(fname);
        const base = path.basename(fname, ext);
        dest = path.join(dir, `${base}_restored_${ts}${ext}`);
      }
      try {
        fs.renameSync(src, dest);
        const who = req.headers['x-web-user'] || req.body && req.body.requestedBy || 'web';
        const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'restore_from_trash', guild: gid, file: fname, dest: path.basename(dest), by: who }) + '\n';
        try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); }
      } catch (e) { return res.status(500).json({ error: String(e) }); }
      return res.json({ ok: true, restoredTo: path.basename(dest) });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // permanently delete a trashed playlist file
  app.delete('/api/guild/:id/playlists/trash/:filename', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.params.filename;
      if (!fname || fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      const trashDir = guildTrashDir(gid);
      const fpath = path.join(trashDir, fname);
      if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not_found' });
      try { fs.unlinkSync(fpath); const who = req.headers['x-web-user'] || 'web'; const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'permanent_delete', guild: gid, file: fname, by: who }) + '\n'; try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); } } catch (e) { return res.status(500).json({ error: String(e) }); }
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // save/overwrite a playlist file (accepts { items: [...] })
  app.post('/api/guild/:id/playlists/:filename', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.params.filename;
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : null;
      if (!fname || fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      // ensure filename is inside the guild directory (we only accept basenames)
      if (!items) return res.status(400).json({ error: 'missing_items' });
      const dir = guildPlaylistsDir(gid);
      const fpath = path.join(dir, fname);
      try { fs.writeFileSync(fpath, JSON.stringify(items, null, 2), 'utf8'); } catch (e) { return res.status(500).json({ error: String(e) }); }
      // log update
      const who = req.headers['x-web-user'] || body.requestedBy || 'web';
      const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'update_playlist', guild: gid, file: fname, by: who, count: items.length }) + '\n';
      try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); }
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // create a new playlist file: accepts { name: 'baseName', items: [...] }
  app.post('/api/guild/:id/playlists', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const body = req.body || {};
      const base = body.name ? String(body.name).replace(/[^a-zA-Z0-9_\-]/g, '_') : 'playlist';
      const items = Array.isArray(body.items) ? body.items : [];
      // create inside guild-specific directory; add suffix if name exists
      const dir = guildPlaylistsDir(gid);
      let fname = `${base}.json`;
      let counter = 1;
      while (fs.existsSync(path.join(dir, fname))) {
        fname = `${base}_${counter}.json`;
        counter += 1;
      }
      const fpath = path.join(dir, fname);
      try { fs.writeFileSync(fpath, JSON.stringify(items, null, 2), 'utf8'); } catch (e) { return res.status(500).json({ error: String(e) }); }
      const who = req.headers['x-web-user'] || body.requestedBy || 'web';
      const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'create_playlist', guild: gid, file: fname, by: who, count: items.length }) + '\n';
      try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); }
      return res.json({ ok: true, filename: fname });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // rename a playlist file: body { newName }
  app.post('/api/guild/:id/playlists/:filename/rename', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.params.filename;
      const newNameRaw = req.body && req.body.newName ? String(req.body.newName) : null;
      if (!fname || fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      // enforce that the source file belongs to this guild (located in guild folder)
      if (!newNameRaw) return res.status(400).json({ error: 'missing_new_name' });
      // sanitize new name (keep alnum, - and _)
      const base = newNameRaw.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 128) || 'playlist';
      const ext = path.extname(fname) || '.json';
      // build new filename without guild id or timestamp; add numeric suffix if needed
      const dir = guildPlaylistsDir(gid);
      let newFname = `${base}${ext}`;
      let counter = 1;
      while (fs.existsSync(path.join(dir, newFname))) {
        newFname = `${base}_${counter}${ext}`;
        counter += 1;
      }
      const src = path.join(dir, fname);
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'not_found' });
      const dest = path.join(dir, newFname);
      try {
        fs.renameSync(src, dest);
        const who = req.headers['x-web-user'] || req.body.requestedBy || 'web';
        const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'rename_playlist', guild: gid, from: fname, to: newFname, by: who }) + '\n';
        try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); }
        return res.json({ ok: true, filename: newFname });
      } catch (e) { return res.status(500).json({ error: String(e) }); }
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // delete a saved playlist file (only files that include the guild id in the name)
  app.delete('/api/guild/:id/playlists/:filename', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.params.filename;
      // simple safety checks
      if (!fname || fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      const dir = guildPlaylistsDir(gid);
      const fpath = path.join(dir, fname);
      if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not_found' });
      // move to trash instead of permanent delete
      try {
        const trashDir = guildTrashDir(gid);
        let dest = path.join(trashDir, fname);
        if (fs.existsSync(dest)) {
          const ts = Date.now();
          const ext = path.extname(fname);
          const base = path.basename(fname, ext);
          dest = path.join(trashDir, `${base}_${ts}${ext}`);
        }
        fs.renameSync(fpath, dest);
        // log action
        const who = req.headers['x-web-user'] || req.body && req.body.requestedBy || 'web';
        const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'move_to_trash', guild: gid, file: fname, dest: path.basename(dest), by: who }) + '\n';
        try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); }
      } catch (e) { return res.status(500).json({ error: String(e) }); }
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // list trashed playlist files for a guild
  app.get('/api/guild/:id/playlists/trash', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const dir = guildTrashDir(gid);
      if (!fs.existsSync(dir)) return res.json([]);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      return res.json(files);
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // restore a trashed playlist back to playlists dir
  app.post('/api/guild/:id/playlists/trash/restore', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.body && req.body.filename ? String(req.body.filename) : null;
      if (!fname) return res.status(400).json({ error: 'missing_filename' });
      if (fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      const trashDir = guildTrashDir(gid);
      const src = path.join(trashDir, fname);
      if (!fs.existsSync(src)) return res.status(404).json({ error: 'not_found' });
      const dir = guildPlaylistsDir(gid);
      let dest = path.join(dir, fname);
      if (fs.existsSync(dest)) {
        const ts = Date.now();
        const ext = path.extname(fname);
        const base = path.basename(fname, ext);
        dest = path.join(dir, `${base}_restored_${ts}${ext}`);
      }
      try {
        fs.renameSync(src, dest);
        const who = req.headers['x-web-user'] || req.body && req.body.requestedBy || 'web';
        const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'restore_from_trash', guild: gid, file: fname, dest: path.basename(dest), by: who }) + '\n';
        try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); }
      } catch (e) { return res.status(500).json({ error: String(e) }); }
      return res.json({ ok: true, restoredTo: path.basename(dest) });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // permanently delete a trashed playlist file
  app.delete('/api/guild/:id/playlists/trash/:filename', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = req.params.filename;
      if (!fname || fname.indexOf('..') !== -1 || path.basename(fname) !== fname) return res.status(400).json({ error: 'invalid_filename' });
      const trashDir = guildTrashDir(gid);
      const fpath = path.join(trashDir, fname);
      if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'not_found' });
      try { fs.unlinkSync(fpath); const who = req.headers['x-web-user'] || 'web'; const logLine = JSON.stringify({ ts: new Date().toISOString(), action: 'permanent_delete', guild: gid, file: fname, by: who }) + '\n'; try { fs.appendFileSync(PLAYLIST_ACTIONS_LOG, logLine, 'utf8'); } catch (e) { console.error('Failed to write playlist_actions.log', e); } } catch (e) { return res.status(500).json({ error: String(e) }); }
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // enqueue a saved playlist file into the guild queue (will not join voice channel automatically)
  app.post('/api/guild/:id/playplaylist', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const fname = (req.body && req.body.filename) ? String(req.body.filename) : null;
      if (!fname) return res.status(400).json({ error: 'missing_filename' });
      const fpath = path.join(guildPlaylistsDir(gid), fname);
      if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'file_not_found' });
      const raw = fs.readFileSync(fpath, 'utf8');
      const items = JSON.parse(raw);
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'invalid_playlist' });
      let q = queues.get(gid);
      if (!q) { q = createQueue(gid); queues.set(gid, q); }
      items.forEach((it, idx) => q.songs.push({ title: it.title, url: it.url, requestedBy: req.body.requestedBy || 'web', originPlaylist: fname, originIndex: idx + 1 }));
      q.lastRequested = { title: items[0].title, url: items[0].url, requestedBy: req.body.requestedBy || 'web' };
      try { lastTracks[gid] = q.lastRequested; saveLastTracks(); } catch (e) {}
      // do not attempt to join voice; playback will start when a connection exists
      return res.json({ ok: true, added: items.length });
    } catch (e) { console.error('playplaylist api error', e); return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/toggleShuffle', checkSecret, (req, res) => {
    try {
      const q = queues.get(req.params.id);
      if (!q) return res.status(400).json({ error: 'no_queue' });
      q.shuffleEnabled = !q.shuffleEnabled;
      if (q.shuffleEnabled && q.songs && q.songs.length > 1) {
        for (let i = q.songs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const tmp = q.songs[i]; q.songs[i] = q.songs[j]; q.songs[j] = tmp; }
      }
      try { settings[req.params.id] = settings[req.params.id] || {}; settings[req.params.id].shuffle = !!q.shuffleEnabled; saveSettings(); } catch (e) {}
      return res.json({ ok: true, shuffle: q.shuffleEnabled });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/guild/:id/toggleRepeat', checkSecret, (req, res) => {
    try {
      const q = queues.get(req.params.id);
      if (!q) return res.status(400).json({ error: 'no_queue' });
      if (q.repeatMode === 'off') q.repeatMode = 'one'; else if (q.repeatMode === 'one') q.repeatMode = 'all'; else q.repeatMode = 'off';
      try { settings[req.params.id] = settings[req.params.id] || {}; settings[req.params.id].repeatMode = q.repeatMode; saveSettings(); } catch (e) {}
      return res.json({ ok: true, repeatMode: q.repeatMode });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // clear the upcoming queue (does not stop current track)
  app.post('/api/guild/:id/clearQueue', checkSecret, (req, res) => {
    try {
      const gid = req.params.id;
      const q = queues.get(gid);
      if (!q) return res.status(400).json({ error: 'no_queue' });
      q.songs = [];
      // update controls message if present
      try { updateControlsMessage(gid); } catch (e) {}
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  // send a message to a channel (useful to post links/alerts)
  app.post('/api/guild/:id/send', checkSecret, async (req, res) => {
    try {
      const { channelId, content } = req.body || {};
      if (!channelId || !content) return res.status(400).json({ error: 'missing_fields' });
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || typeof ch.send !== 'function') return res.status(404).json({ error: 'channel_not_found' });
      await ch.send(String(content));
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ error: String(e) }); }
  });

  app.listen(WEB_PORT, () => console.log(`Web management UI listening on http://darknio.ovh:${WEB_PORT}`));
} catch (e) {
  console.error('Failed to start web UI server:', e && e.message ? e.message : e);
}

// ------------------------------------------------------------------------
