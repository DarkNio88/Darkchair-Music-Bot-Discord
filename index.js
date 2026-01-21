require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } = require('discord.js');
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
    volume: 0.8,
  };
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  const song = q.songs.shift();
  // Push previous current into history before replacing
  if (q.current) {
    try { q.history.push(q.current); } catch (e) {}
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
async function fetchImageAsDataURI(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const http = u.protocol === 'https:' ? require('https') : require('http');
    return await new Promise((resolve) => {
      const req = http.get(u, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const ct = res.headers['content-type'] || 'image/png';
            const base = buf.toString('base64');
            resolve(`data:${ct};base64,${base}`);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.abort(); resolve(null); });
    });
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
  const position = (q.history ? q.history.length : 0) + 1;
  const totalQueue = (q.history ? q.history.length : 0) + (q.songs ? (1 + q.songs.length) : 1);
  const volume = typeof q.volume === 'number' ? Math.round((q.volume || 0.8) * 100) : 80;
  const format = q.currentFormat || 'unknown';
  const bitrate = q.currentBitrate && q.currentBitrate > 0 ? `${q.currentBitrate} kbps` : 'unknown';

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
  svgParts.push(`<text x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='106' font-family='Arial, Helvetica, sans-serif' font-size='12' fill='#bfcfe6'>${total > 0 ? `${fmt(elapsed)} / ${fmt(total)}` : (q && q.current ? '??:??' : '')}</text>`);
  svgParts.push(`<rect x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='120' width='${contentWidth}' height='18' rx='9' fill='#1f2937' />`);
  svgParts.push(`<rect x='${20 + (hasThumb ? coverSize + 20 : 0)}' y='120' width='${barWidth}' height='18' rx='9' fill='#10b981' />`);
  svgParts.push(`<text x='20' y='${height - 16}' font-family='Arial, Helvetica, sans-serif' font-size='10' fill='#9ca3af'>DarkChair Music</text>`);
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

  const embed = new EmbedBuilder().setTitle('Controlli Riproduzione').setImage(`attachment://${imageName}`);

  const prev = new ButtonBuilder().setCustomId(`prev:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏮️');
  const play = new ButtonBuilder().setCustomId(`play_pause:${guildId}`).setStyle(ButtonStyle.Success).setLabel('⏯️');
  const next = new ButtonBuilder().setCustomId(`next:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏭️');
  const stop = new ButtonBuilder().setCustomId(`stop:${guildId}`).setStyle(ButtonStyle.Danger).setLabel('⏹️');
  const progress = new ButtonBuilder().setCustomId(`progress:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('Progress');

  // volume controls (separate row to respect max 5 components per row)
  const volDown = new ButtonBuilder().setCustomId(`vol_down:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('🔉');
  const volUp = new ButtonBuilder().setCustomId(`vol_up:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('🔊');

  const row = new ActionRowBuilder().addComponents(prev, play, next, stop, progress);
  const row2 = new ActionRowBuilder().addComponents(volDown, volUp);

  const content = `${title}\n${total > 0 ? `${fmt(elapsed)} / ${fmt(total)}` : (q && q.current ? 'Posizione: ??:??' : '')}`;

  return { content, embeds: [embed], components: [row, row2], files: [file] };
}

// Update the controls message for a guild (if exists)
async function updateControlsMessage(guildId) {
  try {
    const q = queues.get(guildId);
    if (!q || !q.controlsMessage) return;
    const payload = await buildControlsMessageForQueue(q, guildId);
    try {
      // when editing, include files so the attachment image is updated
      await q.controlsMessage.edit({ content: payload.content, embeds: payload.embeds, components: payload.components, files: payload.files });
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
      console.log('messageCreate:', { author: authorTag, guild: message.guild && message.guild.id, channel: message.channel && message.channel.id, contentPreview: (message.content||'').slice(0,120) });
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
  const valid = new Set(['play','p','skip','stop','queue','q','np','replay','r']);
  // support posting the controls panel
  valid.add('controls');
  valid.add('c');
  if (!valid.has(cmd)) return;
  console.log(`Command received from ${message.author.tag}: ${message.content}`);

  // Helper: build the controls message for this guild
  function buildControlsMessage(guildId) {
    const q = queues.get(guildId);
    const title = q && q.current ? q.current.title : 'Nessuna traccia in riproduzione';
    const embed = new EmbedBuilder().setTitle('Controlli Riproduzione');

    const prev = new ButtonBuilder().setCustomId(`prev:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏮️');
    const play = new ButtonBuilder().setCustomId(`play_pause:${guildId}`).setStyle(ButtonStyle.Success).setLabel('⏯️');
    const next = new ButtonBuilder().setCustomId(`next:${guildId}`).setStyle(ButtonStyle.Primary).setLabel('⏭️');
    const stop = new ButtonBuilder().setCustomId(`stop:${guildId}`).setStyle(ButtonStyle.Danger).setLabel('⏹️');
    const progress = new ButtonBuilder().setCustomId(`progress:${guildId}`).setStyle(ButtonStyle.Secondary).setLabel('Progress');

    const row = new ActionRowBuilder().addComponents(prev, play, next, stop, progress);
    return { embeds: [embed], components: [row] };
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
        items.forEach((it) => q.songs.push({ title: it.title, url: it.url, requestedBy: message.author.username }));
        // Remember last requested as first item
        q.lastRequested = { title: items[0].title, url: items[0].url, requestedBy: message.author.username };
        try { lastTracks[message.guild.id] = q.lastRequested; saveLastTracks(); } catch (e) { console.error('Failed to persist lastRequested for guild', message.guild.id, e && e.message ? e.message : e); }
        await replyAndDelete(message, `Aggiunta ${items.length} brani dalla playlist: **${items[0].title}**`);
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
      await replyAndDelete(message, `Aggiunto in coda: **${title}**`);
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
      await replyAndDelete(message, 'Pannello di controllo inviato.');
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
      await replyAndDelete(message, `Riproduco l'ultimo brano memorizzato: **${title}**`);
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

  if (cmd === 'skip') {
    const q = queues.get(message.guild.id);
    if (!q) { await replyAndDelete(message, 'Nessuna musica in riproduzione.'); return; }
    q.player.stop();
    await replyAndDelete(message, 'Brano saltato.');
  }

  if (cmd === 'stop') {
    const q = queues.get(message.guild.id);
    if (!q) { await replyAndDelete(message, 'Nessuna musica in riproduzione.'); return; }
    try { q.songs = []; q.player.stop(); if (q.connection) q.connection.destroy(); } catch (e) { console.error('Stop error:', e); }
    queues.delete(message.guild.id);
    await replyAndDelete(message, 'Riproduzione fermata e coda svuotata.');
  }

  if (cmd === 'queue' || cmd === 'q') {
    const q = queues.get(message.guild.id);
    if (!q || (!q.current && q.songs.length === 0)) { await replyAndDelete(message, 'Coda vuota.'); return; }
    const lines = [];
    if (q.current) lines.push(`Now playing: ${q.current.title}`);
    q.songs.slice(0, 10).forEach((s, i) => lines.push(`${i + 1}. ${s.title}`));
    await replyAndDelete(message, lines.join('\n'));
  }

  if (cmd === 'np') {
    const q = queues.get(message.guild.id);
    if (!q || !q.current) { await replyAndDelete(message, 'Nessuna traccia in riproduzione.'); return; }
    await replyAndDelete(message, `Now playing: ${q.current.title}`);
  }
});

// Handle button interactions for playback controls
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const [action, guildId] = interaction.customId.split(':');
    const q = queues.get(interaction.guildId || guildId);
    if (!q) return interaction.reply({ content: 'Nessuna riproduzione attiva.', flags: 64 });

    if (action === 'play_pause') {
      try {
        if (q.player.state.status === AudioPlayerStatus.Playing) {
          q.player.pause();
          await interaction.reply({ content: 'Pausa.', flags: 64 });
        } else {
          q.player.unpause();
          await interaction.reply({ content: 'Riprendo.', flags: 64 });
        }
        // update controls message after action
        updateControlsMessage(interaction.guildId || guildId);
      } catch (e) { console.error('play_pause error', e); await interaction.reply({ content: 'Errore play/pause', flags: 64 }); }
      return;
    }

    if (action === 'next') {
      try { q.player.stop(); await interaction.reply({ content: 'Avanti (skip).', flags: 64 }); updateControlsMessage(interaction.guildId || guildId); } catch (e) { console.error(e); await interaction.reply({ content: 'Errore skip', flags: 64 }); }
      return;
    }

    if (action === 'prev') {
      try {
        if (!q.history || q.history.length === 0) return interaction.reply({ content: 'Nessuna traccia precedente.', flags: 64 });
        const prev = q.history.pop();
        q.songs.unshift(prev);
        q.player.stop();
        await interaction.reply({ content: `Riproduco: ${prev.title}`, flags: 64 });
        updateControlsMessage(interaction.guildId || guildId);
      } catch (e) { console.error('prev error', e); await interaction.reply({ content: 'Errore previous', flags: 64 }); }
      return;
    }

    if (action === 'stop') {
      try {
        q.songs = []; q.player.stop(); if (q.connection) q.connection.destroy();
        try { if (q.controlsInterval) clearInterval(q.controlsInterval); } catch (e) {}
        try { if (q.controlsMessage) q.controlsMessage.delete().catch(()=>{}); } catch (e) {}
        queues.delete(interaction.guildId || guildId);
        await interaction.reply({ content: 'Stop e coda svuotata.', flags: 64 });
      } catch (e) { console.error('stop error', e); await interaction.reply({ content: 'Errore stop', flags: 64 }); }
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
        await interaction.reply({ content: `Volume: ${Math.round(q.volume * 100)}%`, flags: 64 });
        updateControlsMessage(interaction.guildId || guildId);
      } catch (e) { console.error('volume change error', e); await interaction.reply({ content: 'Errore volume', flags: 64 }); }
      return;
    }

    if (action === 'progress') {
      try {
        if (!q.current) return interaction.reply({ content: 'Nessuna traccia in riproduzione.', flags: 64 });
        const elapsed = q.startedAt ? Math.max(0, Date.now() - q.startedAt) : 0;
        const total = q.currentDuration || 0;
        const fmt = (ms) => {
          const s = Math.floor(ms / 1000);
          const m = Math.floor(s / 60);
          const sec = s % 60;
          return `${m}:${String(sec).padStart(2, '0')}`;
        };
        let bar = '';
        if (total > 0) {
          const pct = Math.min(1, elapsed / total);
          const filled = Math.round(pct * 20);
          bar = '▰'.repeat(filled) + '▱'.repeat(20 - filled) + ` ${Math.round(pct * 100)}%`;
        } else {
          bar = 'Progressione non disponibile';
        }
        await interaction.reply({ content: `Now playing: ${q.current.title}\n${fmt(elapsed)} / ${total > 0 ? fmt(total) : '??:??'}\n${bar}`, flags: 64 });
      } catch (e) { console.error('progress error', e); await interaction.reply({ content: 'Errore progress', flags: 64 }); }
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
