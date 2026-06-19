# QQ Bot Studio

QQ Bot Studio is a local-first web workspace for creating private QQ companion bots.

It can:

- Import `.txt` exports from QQChatExporter.
- Build a persona from chat style signals such as speakers, time range, short phrases, punctuation, and media frequency.
- Create a bot from manual profile data only, without importing a chat log.
- Let you add custom personality notes, key facts, relationship memories, speaking style, response rules, and forbidden patterns.
- Configure provider settings, bot QQ, allowed private user QQs, and OneBot WebSocket URL from the web UI.
- Start NapCat, display the login QR code, and start or stop generated bot projects from the web UI.
- Run locally, on a LAN machine, or on a Windows VPS with a web access password.

## Privacy Model

This repository is designed so private data stays out of Git:

- Runtime data is written to `workspace/`, which is ignored by Git.
- Imported chat logs are stored under `workspace/projects/<project>/source/`.
- Generated persona files are stored under `workspace/projects/<project>/skill/`.
- Saved API settings are stored under `workspace/api-settings.local.json` only if you choose to remember the key.
- `.gitignore` excludes common QQ/NapCat data, QR codes, chat exports, logs, and local secrets.

Before publishing, run:

```powershell
npm run privacy:scan
```

## Requirements

- Windows 10/11 or Windows Server for NapCat.
- Node.js 22 or newer.
- NapCat-QCE-Windows configured with OneBot 11 WebSocket.
- DeepSeek or OpenAI-compatible API key.

## Local Start

From the repository directory:

```powershell
npm start
```

Then open:

```text
http://127.0.0.1:8790
```

On Windows you can also double-click:

```text
start-studio.cmd
```

If NapCat is not placed next to this repository, set `NAPCAT_DIR`:

```powershell
$env:NAPCAT_DIR="C:\path\to\NapCat-QCE-Windows-x64"
npm start
```

## Create A Bot

1. Open the studio web page.
2. Save a DeepSeek or OpenAI API key in the `API` section.
3. Import a QQChatExporter `.txt` file, paste exported text, or leave chat text empty and fill manual profile fields.
4. Fill:
   - project name
   - persona nickname
   - your nickname
   - bot QQ
   - allowed private user QQs
   - OneBot WebSocket URL
5. Optional manual profile fields:
   - personality notes
   - key facts
   - relationship memories
   - speaking style
   - response rules
   - forbidden patterns
6. Click `Analyze` when a chat log is present.
7. Click `Create Project`.
8. Click `Start NapCat`, scan the QR code with mobile QQ, and wait for OneBot to become available.
9. Click `Start` on the generated project card.

Generated projects are saved under:

```text
workspace/projects/<project-id>
```

Each project contains:

```text
skill/SKILL.md
skill/persona.md
skill/memories.md
skill/meta.json
bot/config.json
bot/bot.js
source/
```

## Environment Variables

See `.env.example` for a concise template.

Common variables:

```powershell
$env:BOT_STUDIO_HOST="127.0.0.1"
$env:BOT_STUDIO_PORT="8790"
$env:BOT_STUDIO_PASSWORD="change-me"
$env:NAPCAT_DIR="C:\path\to\NapCat-QCE-Windows-x64"
```

`BOT_STUDIO_PASSWORD` is required if you expose the studio beyond localhost.

## Windows VPS Deployment

Use a Windows VPS or cloud desktop if you want 24/7 availability.

### 1. Prepare The VPS

Install:

- Node.js 22+
- NapCat-QCE-Windows
- this repository

Check Node:

```powershell
node -v
```

### 2. Start With A Password

From the repository directory:

```powershell
$env:BOT_STUDIO_HOST="0.0.0.0"
$env:BOT_STUDIO_PORT="8790"
$env:BOT_STUDIO_PASSWORD="replace-with-a-strong-password"
$env:NAPCAT_DIR="C:\path\to\NapCat-QCE-Windows-x64"
node server.js
```

Open:

```text
http://<server-ip>:8790
```

### 3. Open The Firewall Port

Run PowerShell as administrator:

```powershell
New-NetFirewallRule -DisplayName "QQ Bot Studio 8790" -Direction Inbound -Protocol TCP -LocalPort 8790 -Action Allow
```

For better security, restrict access to your own IP address or keep the studio bound to localhost and use Remote Desktop.

### 4. Keep The Process Running

Simple option: keep the PowerShell window open.

PM2 option:

```powershell
npm install -g pm2
pm2 start server.js --name qq-bot-studio
pm2 save
pm2 status
pm2 logs qq-bot-studio
```

For auto-start after reboot, configure PM2 startup for Windows, NSSM, or Windows Task Scheduler.

## LAN Access

For same-network access:

```powershell
$env:BOT_STUDIO_HOST="0.0.0.0"
$env:BOT_STUDIO_PORT="8790"
$env:BOT_STUDIO_PASSWORD="replace-with-a-strong-password"
node server.js
```

Find the LAN IP:

```powershell
ipconfig
```

Then open:

```text
http://<lan-ip>:8790
```

## Security Notes

- Never expose the studio publicly without `BOT_STUDIO_PASSWORD`.
- Prefer HTTPS or a secure tunnel for public access.
- Do not commit `workspace/`, chat exports, API keys, QR codes, generated private persona projects, or NapCat cache data.
- The web UI can start bots and display login QR codes, so treat access as sensitive.
