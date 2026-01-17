# DarkNio — Discord bot (starter)

This repository contains the Discord bot and the `darkchair_api_youtube` helper module to manage YouTube auth (Puppeteer) and yt-dlp streaming.

Quick start

1. Install dependencies and yt-dlp:

```bash
cd /root/music/darkchair_api_youtube
npm run install-deps
```

2. Configure environment (create `.env` in `/root/music`):

```ini
# Example
AUTH_PORT=3001
AUTH_UI_USERS=admin:secret
PUPPETEER_PROFILE=.local-firefox-profile
# Discord bot token and other settings for your bot
DISCORD_TOKEN=your-token-here
```

3. Start the bot in a detached screen session (recommended):

```bash
cd /root/music
chmod +x start-discord-bot-screen.sh
./start-discord-bot-screen.sh darkchair-bot
```

Alternatively start interactively (uses `xvfb-run` when available):

```bash
cd /root/music/darkchair_api_yt
npm run auth
```

Initialize Git

If you haven't already initialized the git repository, run:

```bash
cd /root/music
git init
git add .
git commit -m "Initial commit — Discord bot + darkchair_api_yt"
```

Security notes

- Keep `.env` and `cookies.txt` private (they are included in `.gitignore`).
- Do not expose the auth UI to the public internet without additional protections (reverse-proxy auth, firewall, HTTPS).

Support

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y8Y31SFJ81)
# Bot Musica Discord (YouTube)

Breve guida per avviare il bot musicale che riproduce audio da YouTube.

Prerequisiti:
- Node.js 18+ e npm
- Un bot token Discord (create una applicazione su https://discord.com/developers)

Installazione:

```bash
cd bot-musica
npm install
```

Configurazione:
- Crea un file `.env` nella cartella `bot-musica` con:

```
BOT_TOKEN=tuo_token_qui
PREFIX=!
```

Uso:
- Avvia il bot con `npm start`.
- Comandi disponibili (prefisso di default `!`):
  - `!play <url o ricerca>`: aggiunge e riproduce dalla coda
  - `!skip`: salta il brano corrente
  - `!stop`: ferma la riproduzione e svuota la coda
  - `!queue` o `!q`: mostra la coda
  - `!np`: mostra il brano in riproduzione

Note:
- Il bot deve essere invitato con i permessi per connettersi e parlare nei canali vocali.
- Per migliori risultati usa node con sufficiente memoria; ytdl-core scarica lo stream in tempo reale.
