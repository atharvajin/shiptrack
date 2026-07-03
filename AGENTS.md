# ShipTrack — Agent Memory

## How to Run
```powershell
# Start API backend (port 4000)
cd C:\Users\Jog JK\shiptrack-v2-vercel-fixed
node server.js

# Start frontend (port 3000) in a separate terminal
cd C:\Users\Jog JK\shiptrack-v2-vercel-fixed\frontend
npx vite --port 3000
```

Then open http://localhost:3000 in your browser.

## Puppeteer Scraper
- `api/lib/scraper.js` — `scrapeWithBrowser(url)` auto-detects Chrome installation
- Used as fallback when HTTP scraping returns Pending (for JS-rendered courier pages like Ekart)
- Chrome path detection: `C:\Program Files\Google\Chrome\Application\chrome.exe`, then (x86), then LocalAppData, then `$CHROME_PATH`, then `where chrome`
- Browser instance is cached and reused across requests

## Bugs Fixed (July 2026)

### 1. Refresh-tracking endpoint broken (500 error)
- **Root cause**: `api/orders/refresh-tracking.js` used `../../lib/` import paths (e.g., `../../lib/supabase`) but the file is at `api/orders/` level, not `api/` level. The correct path is `../lib/`.
- **Fix**: Changed all 5 `require()` paths from `../../lib/...` to `../lib/...`.

### 2. Ekart delivered packages showing "Out for Delivery" (never settling on "Delivered")
- **Root cause**: `scrapeEkartHtml()` in `api/lib/scraper.js` checked "out for delivery" BEFORE "delivered". A delivered Ekart page almost always contains "out for delivery" in history text (e.g., "Out for delivery with courier agent"), so the regex/if-else matched that first, returning "Out for Delivery" for delivered packages. Combined with the frontend auto-refresh (which skips only terminal statuses), this created an infinite refresh loop.
- **Fix**: Reordered status detection — "delivered" is now checked first, then "out for delivery". Also removed the duplicate regex + if-else pass (they unconditionally overwrote each other).

### 3. `normalizeStatus(null)` defaulted to "In Transit"
- **Root cause**: `api/lib/scraper.js:57` — `if (!raw) return 'In Transit'`. A null/empty status should default to "Pending", not "In Transit".
- **Fix**: Changed to `return 'Pending'`.

### 4. Refresh-tracking froze stale status on scrape failure
- **Root cause**: `api/orders/refresh-tracking.js:82-84` — `scraped.status || shipment.last_status || "Pending"`. If a new scrape failed, it fell back to the old DB status, never resetting to "Pending".
- **Fix**: Changed to `scraped.status || "Pending"` (same as `add-tracking.js`).

### 5. `normalizeAppStatus` (in both API files) didn't recognize all `normalizeStatus` outputs
- **Root cause**: `normalizeStatus` in `scraper.js` can return 14 statuses (Delivered, Out for Delivery, Delivery Attempted, Unserviceable, Dispatched, Picked Up, In Transit, At Local Facility, Return to Origin, Cancelled, Lost, Damaged, On Hold, Info Received). `normalizeAppStatus` (duplicated in both `add-tracking.js` and `refresh-tracking.js`) only recognized 5 — all others fell through to `return status` unchanged.
- **Fix**: Expanded both `normalizeAppStatus` functions to recognize all 14 statuses with proper keyword matching. "Delivered" now checked first (to avoid history text confusion). "Exception" narrowed to only "exception" and "failed" (not "attempted" which is now its own status).

### 6. Frontend missing colors for 7 statuses + pulse for Delivery Attempted/On Hold
- **Root cause**: `App.jsx` `STATUS_COLORS` only had colors for 5 statuses. `StatusBadge` pulse only covered 2 statuses.
- **Fix**: Added colors for Return to Origin, Cancelled, Lost, Damaged, Delivery Attempted, Unserviceable, On Hold. Pulse now includes Delivery Attempted and On Hold.

### 7. `TERMINAL_STATUSES` list too narrow
- **Root cause**: `App.jsx` auto-refresh only skipped Delivered, Cancelled, Return to Origin, Lost, Damaged — missing Delivery Attempted, On Hold, Unserviceable.
- **Fix**: Added all 3 missing terminal statuses.

### 8. Frontend refresh-tracking URL routing bug
- **Root cause**: `TrackingCard` called `POST /orders/${orderId}/refresh-tracking` but the actual endpoint is `POST /orders/refresh-tracking?order_id=${orderId}`.
- **Fix**: Changed to `POST /orders/refresh-tracking?order_id=${orderId}`.

## Key Files Modified
- `api/orders/refresh-tracking.js` — import paths, fallback behavior, normalizeAppStatus
- `api/lib/scraper.js` — normalizeStatus default, scrapeEkartHtml priority + fallback
- `api/add-tracking.js` — normalizeAppStatus expanded
- `frontend/src/App.jsx` — routing bug, STATUS_COLORS, pulse, TERMINAL_STATUSES, auto-refresh

## Scraper Architecture
- `api/lib/scraper.js` (704 lines) — 12 courier strategies (Ekart, Delhivery, Shiprocket, BlueDart, DTDC, Ecom Express, Xpressbees, India Post, FedEx, DHL, Shadowfax, Amazon Logistics)
- HTTP-only scraping — no Puppeteer despite having `@sparticuz/chromium` + `puppeteer-core` in root package.json
- Couriers implement `match` (regex) + `scrape` (async function)
- `scrapeTrackingUrl(url)` → finds strategy → tries strategy → falls back to generic HTML scrape
- `normalizeStatus(raw)` — maps raw text to 14 canonical statuses
- `scrapeHtml(html, courierName)` — strips tags, scans full text against STATUS_MAP, extracts tables/timelines
