# Putting the YapOS Dashboard online

This guide takes you from nothing to a working dashboard website. You do it once. It takes about 20 minutes. You do not need to know how to code: you copy commands, paste them, and press Enter.

The dashboard runs on **Cloudflare Workers** (free plan is enough). The bot keeps running on Yapin' hosting and talks to the dashboard over HTTPS.

You will need:

- A computer with **Node.js 22 or newer** (check with `node --version`).
- The YapOS folder on that computer.
- Access to the Yapin' developer settings for the YapOS bot.

Every command below is typed in a terminal **inside the `dashboard` folder**. To get there, open a terminal in the YapOS folder and run:

```
cd dashboard
```

---

## 1. Create a Cloudflare account

1. Go to https://dash.cloudflare.com/sign-up and sign up (free).
2. Confirm your email address.
3. In the Cloudflare dashboard, open **Workers & Pages** once. If it asks you to pick a `workers.dev` subdomain, pick one (for example `jolli`). Your dashboard address will look like `https://yapos-dashboard.jolli.workers.dev`.

## 2. Install the tools

```
npm install
```

This installs Wrangler (Cloudflare's command line tool) into the `dashboard` folder only. It does not touch the bot.

## 3. Log in to Cloudflare from the terminal

```
npx wrangler login
```

A browser window opens. Click **Allow**. Then come back to the terminal.

## 4. Create the database

```
npx wrangler d1 create yapos-dashboard
```

The output contains a line like:

```
database_id = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab"
```

Copy that id.

## 5. Paste the database id

Open `dashboard/wrangler.toml` in a text editor (Notepad is fine). Find:

```
database_id = "PASTE-YOUR-D1-DATABASE-ID-HERE"
```

Replace `PASTE-YOUR-D1-DATABASE-ID-HERE` with the id you copied. Keep the quotes. Save the file.

## 6. Set your dashboard address

In the same `wrangler.toml`, find:

```
PUBLIC_URL = "https://yapos-dashboard.YOUR-SUBDOMAIN.workers.dev"
```

Replace `YOUR-SUBDOMAIN` with the `workers.dev` subdomain you picked in step 1. No slash at the end. Save the file.

If you are not sure what the address is, do step 9 first: the deploy prints the address. Then come back, fix `PUBLIC_URL`, and deploy again.

## 7. Create the database tables

```
npm run db:init
```

When it asks to continue, answer `y`. Running it again later is safe: it only creates tables that are missing.

## 8. Add the two secrets

Secrets are stored by Cloudflare, never in any file.

**The Yapin' client secret.** Find it in the Yapin' developer settings for YapOS (OAuth2 section). Then run:

```
npx wrangler secret put YAPIN_CLIENT_SECRET
```

Paste the client secret when it asks, and press Enter. (Nothing shows while you paste. That is normal.)

**The bot secret.** This is a long random password that the bot and the dashboard share. Make one with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

It prints 64 random characters. Copy them and keep them somewhere private for step 11 (a password manager is ideal). Then run:

```
npx wrangler secret put BOT_SECRET
```

and paste the same value.

If the first `secret put` asks to create the Worker, answer `y`.

## 9. Deploy

```
npm run deploy
```

At the end it prints your address, for example `https://yapos-dashboard.jolli.workers.dev`. If it does not match `PUBLIC_URL` in `wrangler.toml`, fix `PUBLIC_URL` and run `npm run deploy` again.

Open the address in your browser. You should see the YapOS Dashboard home page.

## 10. Add the redirect URL in Yapin'

1. Open the Yapin' developer settings for YapOS.
2. In the OAuth2 section, add this redirect URL (use your own address):

   ```
   https://yapos-dashboard.jolli.workers.dev/auth/callback
   ```

3. Save.

It must match exactly: `https`, same address, `/auth/callback` at the end, no extra slash.

## 11. Connect the bot

1. Open the YapOS bot on Yapin' and go to the **Hosting** tab.
2. Add two environment variables:

   | Name | Value |
   |---|---|
   | `YAPOS_DASHBOARD_URL` | your dashboard address, e.g. `https://yapos-dashboard.jolli.workers.dev` (no slash at the end) |
   | `YAPOS_DASHBOARD_SECRET` | the bot secret from step 8 (exactly the same value) |

3. Click **Save**, then **Restart**.

If you run the bot on your own computer instead, you can put `dashboardUrl` and `dashboardSecret` in `config.json` (which is never committed).

## 12. Try it

1. Open your dashboard address.
2. Click **Log in with Yapin'** and allow access.
3. You should see the servers where you are an admin or owner. The first load can take a few seconds while the bot answers.

---

## Updating later

After pulling new YapOS code:

```
cd dashboard
npm install
npm run db:init
npm run deploy
```

## Running the tests

```
npm test
```

## Trying the dashboard on your own computer first

```
npm run dev
```

This starts everything locally with no Cloudflare account and no real Yapin' login: the dashboard at http://localhost:8787, a stand-in sign-in page at http://localhost:8788 where you pick a test user (Alex is an admin, Morgan is a moderator, Taylor is not in the server), and a test copy of YapOS with a server called Test Town. Secrets are made up fresh on every start. Logins are kept in `dashboard/.dev/`; run `npm run dev:fresh` to start clean. Press Ctrl+C to stop.

## If something goes wrong

- **"Waiting for YapOS…" never finishes.** The bot is not connected. Check that both Hosting variables are set, that the secret matches the `BOT_SECRET` you put in Cloudflare exactly, and that you restarted the bot. The bot logs one line at start saying whether the dashboard link is on.
- **Login says it failed.** The redirect URL in Yapin' does not match `PUBLIC_URL` + `/auth/callback`, or the client secret is wrong. Run `npx wrangler secret put YAPIN_CLIENT_SECRET` again.
- **"The dashboard database is not set up yet."** The `database_id` in `wrangler.toml` is still the placeholder, or step 7 was skipped.
- **You changed the bot secret.** Put the new value in both places (`npx wrangler secret put BOT_SECRET` and the Hosting tab), then restart the bot.
- **See live errors.** Run `npx wrangler tail` while you reproduce the problem.

Never paste either secret into a chat, a screenshot, a file in this folder, or a commit.
