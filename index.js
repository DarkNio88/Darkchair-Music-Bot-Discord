require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
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
const yt = require('./darkchair_api_yt');
// `ytdl-core-discord` removed — relying on `yt-dlp` via `darkchair_api_yt`
const fs = require('fs');
const path = require('path');

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
  };
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  const song = q.songs.shift();
  q.current = song || null;
  if (!song) {
    q.playing = false;
    setTimeout(() => {
      if (q.player.state.status === 'idle' && q.connection) {
        try { q.connection.destroy(); } catch (e) {}
        queues.delete(guildId);
      }
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

    stream.on('error', (err) => console.error('yt stream error:', err));
      const info = await yt.getInfo(url);
      if (!info) console.error('yt.getInfo returned no metadata for', url);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    if (resource && resource.volume) resource.volume.setVolume(0.8);

    // Ensure process is killed when stream ends
    stream.once('close', () => { try { if (proc) proc.kill(); } catch (e) {} });
    stream.once('end', () => { try { if (proc) proc.kill(); } catch (e) {} });

    return resource;
  } catch (err) {
    console.error('yt-dlp stream failed:', err);
    return null;
  }
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
  try { console.log('messageCreate:', { author: message.author && message.author.tag, guild: message.guild && message.guild.id, channel: message.channel && message.channel.id, contentPreview: (message.content||'').slice(0,120) }); } catch(e){}
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
  if (!valid.has(cmd)) return;
  console.log(`Command received from ${message.author.tag}: ${message.content}`);

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

    const info = await yt.getInfo(url);
    const title = info ? (info.title || info.fulltitle || url) : url;

    try {
      const q = await ensureConnection(voiceChannel, message.guild.id);
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
      if (!q.playing) playNext(message.guild.id);
    } catch (connErr) {
      console.error('Errore connessione voice in play command:', connErr);
      await replyAndDelete(message, 'Impossibile connettersi al canale vocale. Controlla i log per dettagli.');
    }
  }

  if (cmd === 'replay' || cmd === 'r') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) { await replyAndDelete(message, 'Devi essere in un canale vocale per riprodurre l\'ultimo brano.'); return; }
    try {
      const q = await ensureConnection(voiceChannel, message.guild.id);
      if (!q.lastRequested) { await replyAndDelete(message, 'Nessun brano memorizzato da riprodurre.'); return; }
      const { title, url } = q.lastRequested;
      q.songs.push({ title, url, requestedBy: message.author.username });
      await replyAndDelete(message, `Riproduco l'ultimo brano memorizzato: **${title}**`);
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
    const api = require('./darkchair_api_yt');
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
