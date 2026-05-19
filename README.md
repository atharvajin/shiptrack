# ShipTrack — Deploy Guide

**Stack:** React (Vercel) + Serverless API (Vercel) + PostgreSQL (Supabase)
**Cost:** Free on all three platforms

---

## Step 1 — Supabase (database) ~3 mins

1. Go to [supabase.com](https://supabase.com) → New project
2. Give it a name, set a password, choose a region close to you
3. Wait for it to spin up (~1 min)
4. Go to **SQL Editor** → New query → paste the entire contents of `supabase-schema.sql` → click **Run**
5. Go to **Settings → API** and copy:
   - `Project URL` → this is your `SUPABASE_URL`
   - `service_role` key (not anon!) → this is your `SUPABASE_SERVICE_KEY`

---

## Step 2 — GitHub ~2 mins

```bash
git init
git add .
git commit -m "initial commit"
```

Create a new repo on [github.com](https://github.com/new) then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/shiptrack.git
git push -u origin main
```

---

## Step 3 — Vercel (frontend + backend) ~3 mins

1. Go to [vercel.com](https://vercel.com) → Add New Project → Import from GitHub
2. Select your `shiptrack` repo
3. Leave all settings as default (vercel.json handles everything)
4. Go to **Settings → Environment Variables** and add:

| Name | Value |
|------|-------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJ...` (service_role key) |
| `VITE_API_URL` | `/api` |

5. Click **Deploy**

That's it. Your app is live at `https://shiptrack-xxx.vercel.app`

---

## How it works

```
Browser → Vercel (React frontend)
             ↓
         Vercel Serverless Functions (/api/orders/*)
             ↓
         Puppeteer scrapes courier tracking page
             ↓
         Supabase PostgreSQL stores result
```

- Paste any courier URL → Puppeteer opens it in headless Chrome → extracts status, location, history
- Results stored in Supabase → displayed in the React UI
- Supports: Delhivery, BlueDart, FedEx, India Post, DTDC, Ecom Express, Shiprocket + any other courier (generic fallback)

---

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/orders` | List all orders |
| GET | `/api/orders/:id` | Get single order |
| POST | `/api/orders/:id/add-tracking` | Add tracking URL |
| PUT | `/api/orders/:id/update-tracking` | Replace tracking URL |
| POST | `/api/orders/:id/refresh-tracking` | Re-scrape now |
| DELETE | `/api/orders/:id` | Remove tracking |

### Example

```bash
curl -X POST https://your-app.vercel.app/api/orders/ORD-1004/add-tracking \
  -H "Content-Type: application/json" \
  -d '{"tracking_link": "https://www.delhivery.com/track/package?wbn=DEL123456"}'
```

---

## Local development

```bash
# Install Vercel CLI
npm install -g vercel

# Copy env
cp .env.example .env.local
# Fill in your SUPABASE_URL and SUPABASE_SERVICE_KEY

# Run locally (spins up both frontend and API)
vercel dev
```

---

## Troubleshooting

**Scraping times out on Vercel?**
Vercel free tier has a 10s function timeout. Upgrade to Hobby ($20/month) for 60s, or set `maxDuration: 60` in vercel.json (requires Pro).

For production, consider moving scraping to a background job — save the URL immediately, scrape async via a cron service like [cron-job.org](https://cron-job.org) calling `/api/orders/:id/refresh-tracking`.

**Puppeteer not working?**
The `@sparticuz/chromium` package provides a pre-built Chromium binary for AWS Lambda / Vercel. It's included in `api/package.json`. Make sure you ran `npm install` inside the `api/` folder.
