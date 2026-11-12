# YapOS

The all-in-one operating system for your Yapin' server. Moderation, automod, welcomes, role menus and more, organised as **apps** that each server installs or uninstalls with `/apps`.

**YapOS 1.0 "Boot"** · System, Mod, Automod, Welcome, Roles, Levels, Tickets, Studio.

## Run it

Needs Node.js 18 or newer (22+ so the live gateway is used; older versions fall back to long polling).

1. Copy `config.example.json` to `config.json` and paste your bot token (Settings → Developer → your bot → Token).
   Or set the `YAPPER_BOT_TOKEN` environment variable instead. The environment wins over the file.
2. Start it: double-click `start.bat` (it restarts the bot if it crashes), or run:

   ```bash
   npm start
   ```

3. In your server, run `/menu` for the home screen. Admins pick the mod log channel with `/mod log #mod-log`.

`config.json` and `data/` hold your token and your servers' settings. Keep them when you update; replace everything else.

## Commands

| App | Commands |
|---|---|
| System | `/menu` `/help` `/status` `/apps` `/yap` |
| Mod | `/mod` (also `/mod log`, `/mod modrole`) `/warn` `/timeout` `/kick` `/ban` `/purge` `/lock` `/unlock` `/case` |
| Automod | `/automod` |
| Welcome | `/welcome` |
| Roles | `/roles` |
| Levels | `/rank` `/leaderboard` `/levels` |
| Tickets | `/ticket` `/tickets` |
| Studio | `/caption` `/gif` (needs ffmpeg installed) |

Every hub command opens a panel. Most also take typed shortcuts, like `/mod timeout @sam 10m spam`, and `/yap` understands plain words: `/yap timeout @sam 10m`.

## Give the bot a role

Put the bot's role **above** the roles it should manage or moderate, and tick what you use: Manage Messages, Kick, Ban, Timeout Members, Manage Roles, Manage Channels. If a permission is missing, the bot tells you which one in plain words.

## Tests

```bash
npm test
```

Runs the whole bot offline against a simulated Yapin' server: messages, slash commands, clicks, joins and DMs.

## Config options

| Key (`config.json`) | Env var | Default |
|---|---|---|
| `token` | `YAPPER_BOT_TOKEN` | |
| `verified` | `YAPOS_VERIFIED` | `false` (300 messages/min once verified) |
| `ownerId` | `YAPOS_OWNER_ID` | |
| `dataDir` | `YAPOS_DATA_DIR` | `data` |
| `gateway` | `YAPOS_GATEWAY` | `true` |
