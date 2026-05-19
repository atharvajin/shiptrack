const { detectCourierFromUrl } = require('./parser');

const PAGE_TIMEOUT  = 25000;
const WAIT_AFTER_LOAD = 3000;

// ─── Courier-specific scraping strategies ─────────────────────────────────────
const STRATEGIES = [
  {
    name: 'Delhivery', match: /delhivery\.com/i,
    scrape: async (page, url) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
      await page.waitForSelector('[class*="status"], [class*="tracking"]', { timeout: 8000 }).catch(() => {});
      await sleep(WAIT_AFTER_LOAD);
      return page.evaluate(() => {
        const getText = s => document.querySelector(s)?.innerText?.trim() || null;
        const status   = getText('[class*="status-text"]') || getText('[class*="current-status"]') || inferStatus();
        const location = getText('[class*="current-location"]') || getText('[class*="location"]');
        const edd      = getText('[class*="expected-delivery"]') || getText('[class*="estimated"]');
        const history  = [];
        document.querySelectorAll('[class*="track-event"],[class*="timeline-item"],[class*="checkpoint"]').forEach(el => {
          const msg  = el.querySelector('[class*="message"],[class*="status"],p,span')?.innerText?.trim();
          const time = el.querySelector('[class*="time"],[class*="date"],time')?.innerText?.trim();
          const loc  = el.querySelector('[class*="location"],[class*="city"]')?.innerText?.trim();
          if (msg) history.push({ message: msg, timestamp: time || null, location: loc || null });
        });
        function inferStatus() {
          const b = document.body.innerText.toLowerCase();
          if (b.includes('delivered')) return 'Delivered';
          if (b.includes('out for delivery')) return 'Out for Delivery';
          if (b.includes('in transit')) return 'In Transit';
          return 'In Transit';
        }
        return { status, location, estimated_delivery: edd, history };
      });
    },
  },
  {
    name: 'BlueDart', match: /bluedart\.com/i,
    scrape: async (page, url) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
      await sleep(WAIT_AFTER_LOAD);
      return page.evaluate(() => {
        const getText = s => document.querySelector(s)?.innerText?.trim() || null;
        const status   = getText('#divShipmentStatus') || getText('[class*="status"]') || inferStatus();
        const location = getText('#divCurrentLocation') || getText('[class*="location"]');
        const edd      = getText('#divEDD') || getText('[class*="delivery-date"]');
        const history  = [];
        document.querySelectorAll('table tr').forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) history.push({ timestamp: cells[0]?.innerText?.trim(), message: cells[1]?.innerText?.trim(), location: cells[2]?.innerText?.trim() || null });
        });
        function inferStatus() {
          const b = document.body.innerText.toLowerCase();
          if (b.includes('delivered')) return 'Delivered';
          if (b.includes('out for delivery')) return 'Out for Delivery';
          return 'In Transit';
        }
        return { status, location, estimated_delivery: edd, history };
      });
    },
  },
  {
    name: 'FedEx', match: /fedex\.com/i,
    scrape: async (page, url) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
      await page.waitForSelector('[data-testid="tracking-status"],[class*="StatusHeader"]', { timeout: 12000 }).catch(() => {});
      await sleep(WAIT_AFTER_LOAD);
      return page.evaluate(() => {
        const getText = s => document.querySelector(s)?.innerText?.trim() || null;
        const status   = getText('[data-testid="tracking-status"]') || getText('[class*="StatusHeader"]') || inferStatus();
        const location = getText('[data-testid="current-location"]') || getText('[class*="current-location"]');
        const edd      = getText('[data-testid="estimated-delivery"]') || getText('[class*="estimated-delivery"]');
        const history  = [];
        document.querySelectorAll('[data-testid="travel-history-item"],[class*="TravelHistory"] li').forEach(el => {
          history.push({ timestamp: el.querySelector('time,[class*="date"]')?.innerText?.trim() || null, message: el.querySelector('[class*="activity"],p')?.innerText?.trim() || el.innerText?.trim(), location: el.querySelector('[class*="location"]')?.innerText?.trim() || null });
        });
        function inferStatus() {
          const b = document.body.innerText.toLowerCase();
          if (b.includes('delivered')) return 'Delivered';
          if (b.includes('out for delivery')) return 'Out for Delivery';
          return 'In Transit';
        }
        return { status, location, estimated_delivery: edd, history };
      });
    },
  },
  {
    name: 'India Post', match: /indiapost\.gov\.in/i,
    scrape: async (page, url) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
      await sleep(WAIT_AFTER_LOAD);
      return page.evaluate(() => {
        const history = [];
        document.querySelectorAll('#table1 tr,table tr').forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) history.push({ timestamp: cells[0]?.innerText?.trim(), message: cells[1]?.innerText?.trim(), location: cells[2]?.innerText?.trim() || null });
        });
        const last = history[history.length - 1];
        const b = document.body.innerText.toLowerCase();
        const status = b.includes('delivered') ? 'Delivered' : b.includes('out for delivery') ? 'Out for Delivery' : 'In Transit';
        return { status, location: last?.location || null, estimated_delivery: null, history };
      });
    },
  },
];

// ─── Generic fallback ─────────────────────────────────────────────────────────
async function genericScrape(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
  await sleep(WAIT_AFTER_LOAD);
  return page.evaluate(() => {
    const b = document.body.innerText.toLowerCase();
    let status = 'In Transit';
    if (b.includes('delivered') && !b.includes('out for delivery')) status = 'Delivered';
    else if (b.includes('out for delivery')) status = 'Out for Delivery';
    else if (b.includes('exception') || b.includes('failed delivery')) status = 'Exception';

    let location = null;
    for (const s of ['[class*="location"]','[class*="city"]','[id*="location"]']) {
      const el = document.querySelector(s);
      if (el?.innerText?.trim()) { location = el.innerText.trim(); break; }
    }

    const history = [];
    document.querySelectorAll('table tr').forEach((row, i) => {
      if (i === 0) return;
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) history.push({ timestamp: cells[0]?.innerText?.trim(), message: cells[1]?.innerText?.trim(), location: cells[2]?.innerText?.trim() || null });
    });

    if (!history.length) {
      document.querySelectorAll('[class*="timeline"] li,[class*="track"] li').forEach(li => {
        history.push({ timestamp: li.querySelector('time,[class*="date"]')?.innerText?.trim() || null, message: li.innerText?.trim(), location: null });
      });
    }

    return { status, location, estimated_delivery: null, history };
  });
}

// ─── Main exported function ───────────────────────────────────────────────────
async function scrapeTrackingUrl(url) {
  // Use @sparticuz/chromium on Vercel, local chromium otherwise
  let browser;
  try {
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const chromium = require('@sparticuz/chromium');
      const puppeteer = require('puppeteer-core');
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
      });
    }

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    const strategy = STRATEGIES.find(s => s.match.test(url));
    let result;

    if (strategy) {
      console.log(`[Scraper] Using ${strategy.name} strategy`);
      result = await strategy.scrape(page, url);
    } else {
      console.log(`[Scraper] Using generic strategy`);
      result = await genericScrape(page, url);
    }

    result.history  = (result.history || []).filter(h => h.message?.length > 2);
    result.status   = normalizeStatus(result.status);
    result.courier  = strategy?.name || detectCourierFromUrl(url);
    return result;

  } finally {
    if (browser) await browser.close();
  }
}

function normalizeStatus(raw) {
  if (!raw) return 'In Transit';
  const s = raw.toLowerCase();
  if (s.includes('delivered') && !s.includes('out for')) return 'Delivered';
  if (s.includes('out for delivery')) return 'Out for Delivery';
  if (s.includes('in transit') || s.includes('intransit')) return 'In Transit';
  if (s.includes('exception') || s.includes('failed')) return 'Exception';
  if (s.includes('picked up') || s.includes('pickup')) return 'Picked Up';
  return raw;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrapeTrackingUrl };
