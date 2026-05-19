/**
 * Lightweight HTTP-based tracking scraper
 * Works on Vercel free tier — no Puppeteer, no browser
 * Calls courier APIs/JSON endpoints directly
 */

const https = require('https');
const http = require('http');
const { detectCourierFromUrl } = require('./parser');

// ─── HTTP fetch helper ────────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Referer': url,
        ...options.headers,
      },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Courier strategies — direct API calls ────────────────────────────────────
const STRATEGIES = [

  // ── Ekart / Flipkart ────────────────────────────────────────────────────────
  {
    name: 'Ekart',
    match: /ekartlogistics\.com/i,
    scrape: async (url) => {
      const trackingId = url.match(/\/([A-Z0-9]{10,25})\/?$/i)?.[1] ||
                         url.match(/track[=\/]([A-Z0-9]{10,25})/i)?.[1];
      if (!trackingId) throw new Error('Could not extract Ekart tracking ID');

      const apiUrl = `https://api.ekartlogistics.com/v2/shipments/${trackingId}`;
      const res = await fetchUrl(apiUrl, {
        headers: { 'Accept': 'application/json' }
      });

      let data;
      try { data = JSON.parse(res.body); } catch (_) {
        // Fallback: parse HTML page
        return parseHtmlFallback(res.body, 'Ekart');
      }

      const shipment = data?.shipment || data?.data || data;
      const events   = shipment?.events || shipment?.trackingDetails || [];

      return {
        status:             normalizeStatus(shipment?.status || shipment?.currentStatus),
        location:           shipment?.currentLocation || events[0]?.location || null,
        estimated_delivery: shipment?.estimatedDelivery || null,
        history: events.map(e => ({
          timestamp: e.timestamp || e.time || null,
          message:   e.description || e.status || e.message || null,
          location:  e.location || e.city || null,
        })).filter(e => e.message),
      };
    },
  },

  // ── Delhivery ───────────────────────────────────────────────────────────────
  {
    name: 'Delhivery',
    match: /delhivery\.com/i,
    scrape: async (url) => {
      const waybill = url.match(/wbn=([A-Z0-9]+)/i)?.[1] ||
                      url.match(/\/([A-Z0-9]{10,20})\/?$/i)?.[1];
      if (!waybill) throw new Error('Could not extract Delhivery waybill');

      const apiUrl = `https://api.delhivery.com/v3/track?wbn=${waybill}`;
      const res = await fetchUrl(apiUrl, {
        headers: { 'Accept': 'application/json' }
      });

      let data;
      try { data = JSON.parse(res.body); } catch (_) {
        return parseHtmlFallback(res.body, 'Delhivery');
      }

      const pkg      = data?.ShipmentData?.[0]?.Shipment || data?.data?.[0] || {};
      const scans    = pkg?.Scans || pkg?.scans || [];
      const status   = pkg?.Status?.Status || pkg?.status || 'In Transit';

      return {
        status: normalizeStatus(status),
        location: pkg?.Status?.ScanLocation || scans[0]?.ScanDetail?.ScanLocation || null,
        estimated_delivery: pkg?.ExpectedDeliveryDate || null,
        history: scans.map(s => ({
          timestamp: s.ScanDetail?.ScanDateTime || null,
          message:   s.ScanDetail?.Instructions || s.ScanDetail?.Scan || null,
          location:  s.ScanDetail?.ScanLocation || null,
        })).filter(e => e.message),
      };
    },
  },

  // ── Shiprocket tracking page ─────────────────────────────────────────────
  {
    name: 'Shiprocket',
    match: /shiprocket\.in/i,
    scrape: async (url) => {
      const awb = url.match(/awb=([A-Z0-9]+)/i)?.[1] ||
                  url.match(/\/tracking\/([A-Z0-9]+)/i)?.[1];
      if (!awb) throw new Error('Could not extract Shiprocket AWB');

      const apiUrl = `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`;
      const res = await fetchUrl(apiUrl, {
        headers: { 'Accept': 'application/json' }
      });

      let data;
      try { data = JSON.parse(res.body); } catch (_) {
        return parseHtmlFallback(res.body, 'Shiprocket');
      }

      const tracking  = data?.tracking_data || {};
      const shipment  = tracking?.shipment_track?.[0] || {};
      const activities = tracking?.shipment_track_activities || [];

      return {
        status:             normalizeStatus(shipment?.current_status || tracking?.track_status),
        location:           shipment?.origin || activities[0]?.location || null,
        estimated_delivery: shipment?.edd || null,
        history: activities.map(a => ({
          timestamp: a.date || null,
          message:   a.activity || a.status || null,
          location:  a.location || null,
        })).filter(e => e.message),
      };
    },
  },

  // ── BlueDart ─────────────────────────────────────────────────────────────
  {
    name: 'BlueDart',
    match: /bluedart\.com/i,
    scrape: async (url) => {
      const waybill = url.match(/waybill=(\d+)/i)?.[1] ||
                      url.match(/\/(\d{10,12})\/?$/)?.[1];
      if (!waybill) throw new Error('Could not extract BlueDart waybill');

      const apiUrl = `https://api.bluedart.com/servlet/RoutingServlet?handler=tnt&action=custracdtl&colno=${waybill}&checktnt=Y&Type=S&subType=&addtnlType=`;
      const res = await fetchUrl(apiUrl);
      return parseHtmlFallback(res.body, 'BlueDart');
    },
  },

  // ── FedEx ─────────────────────────────────────────────────────────────────
  {
    name: 'FedEx',
    match: /fedex\.com/i,
    scrape: async (url) => {
      const trackNum = url.match(/tracknumbers=(\d+)/i)?.[1] ||
                       url.match(/trackingNumber=(\d+)/i)?.[1];
      if (!trackNum) throw new Error('Could not extract FedEx tracking number');

      const apiUrl = `https://apis.fedex.com/track/v1/trackingnumbers`;
      const res = await fetchUrl(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: trackNum } }] }),
      });

      let data;
      try { data = JSON.parse(res.body); } catch (_) {
        return parseHtmlFallback(res.body, 'FedEx');
      }

      const pkg    = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
      const events = pkg?.dateAndTimes || [];
      const scans  = pkg?.scanEvents || [];

      return {
        status:             normalizeStatus(pkg?.latestStatusDetail?.description),
        location:           pkg?.latestStatusDetail?.scanLocation?.city || null,
        estimated_delivery: pkg?.estimatedDeliveryTimeWindow?.window?.ends || null,
        history: scans.map(s => ({
          timestamp: s.date || null,
          message:   s.eventDescription || null,
          location:  [s.scanLocation?.city, s.scanLocation?.stateOrProvinceCode].filter(Boolean).join(', ') || null,
        })).filter(e => e.message),
      };
    },
  },

  // ── India Post ───────────────────────────────────────────────────────────
  {
    name: 'India Post',
    match: /indiapost\.gov\.in/i,
    scrape: async (url) => {
      const consignmentId = url.match(/consignment_id=([A-Z0-9]+)/i)?.[1] ||
                            url.match(/([A-Z]{2}\d{9}IN)/)?.[1];
      if (!consignmentId) throw new Error('Could not extract India Post consignment ID');

      const apiUrl = `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx`;
      const res = await fetchUrl(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `consignmentNo=${consignmentId}&captchaCode=`,
      });

      return parseHtmlFallback(res.body, 'India Post');
    },
  },

  // ── DTDC ─────────────────────────────────────────────────────────────────
  {
    name: 'DTDC',
    match: /dtdc\.com/i,
    scrape: async (url) => {
      const trackNum = url.match(/trackingno=([A-Z0-9]+)/i)?.[1];
      if (!trackNum) throw new Error('Could not extract DTDC tracking number');

      const apiUrl = `https://tracking.dtdc.com/ctbs-tracking/customerInterface.tr?submitName=getLoadPgFrmExternal&cnNo=${trackNum}&cType=JSON`;
      const res = await fetchUrl(apiUrl);

      let data;
      try { data = JSON.parse(res.body); } catch (_) {
        return parseHtmlFallback(res.body, 'DTDC');
      }

      const scans = data?.trackingDetails || data?.scanDetails || [];
      const last  = scans[scans.length - 1] || {};

      return {
        status:             normalizeStatus(last?.status || last?.scanType),
        location:           last?.location || last?.city || null,
        estimated_delivery: null,
        history: scans.map(s => ({
          timestamp: s.date || s.time || null,
          message:   s.status || s.scanType || s.remarks || null,
          location:  s.location || s.city || null,
        })).filter(e => e.message),
      };
    },
  },

];

// ─── HTML fallback parser ─────────────────────────────────────────────────────
// When JSON API is unavailable, parse raw HTML for keywords
function parseHtmlFallback(html, courierName) {
  if (!html) return { status: 'Pending', location: null, estimated_delivery: null, history: [] };

  const text = html.toLowerCase();

  let status = 'In Transit';
  if (text.includes('delivered')) status = 'Delivered';
  else if (text.includes('out for delivery')) status = 'Out for Delivery';
  else if (text.includes('exception') || text.includes('failed delivery')) status = 'Exception';
  else if (text.includes('picked up') || text.includes('pickup')) status = 'Picked Up';
  else if (text.includes('in transit') || text.includes('intransit')) status = 'In Transit';

  // Try to extract location
  let location = null;
  const locMatch = html.match(/(?:current.{0,20}location|at|reached)[^<]{0,5}[>:]?\s*([A-Z][a-zA-Z\s,]{3,30})</i);
  if (locMatch) location = locMatch[1].trim();

  // Try to extract EDD
  let edd = null;
  const eddMatch = html.match(/(?:expected|estimated).{0,20}delivery.{0,20}(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}\s+\w{3}\s+\d{4})/i);
  if (eddMatch) edd = eddMatch[1];

  // Try to build history from table rows
  const history = [];
  const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rowMatches) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c =>
      c[1].replace(/<[^>]+>/g, '').trim()
    ).filter(Boolean);
    if (cells.length >= 2 && cells[1].length > 3) {
      history.push({ timestamp: cells[0] || null, message: cells[1] || null, location: cells[2] || null });
    }
  }

  return { status, location, estimated_delivery: edd, history };
}

// ─── Main exported function ───────────────────────────────────────────────────
async function scrapeTrackingUrl(url) {
  const strategy = STRATEGIES.find(s => s.match.test(url));

  if (strategy) {
    console.log(`[Scraper] Using ${strategy.name} strategy for: ${url}`);
    try {
      const result = await strategy.scrape(url);
      result.courier  = strategy.name;
      result.status   = normalizeStatus(result.status);
      result.history  = (result.history || []).filter(h => h.message?.length > 2);
      return result;
    } catch (err) {
      console.warn(`[Scraper] ${strategy.name} API failed: ${err.message} — trying HTML fallback`);
      const res = await fetchUrl(url).catch(() => ({ body: '' }));
      const result = parseHtmlFallback(res.body, strategy.name);
      result.courier = strategy.name;
      return result;
    }
  }

  // Unknown courier — fetch the page and parse HTML
  console.log(`[Scraper] Unknown courier, using HTML fallback for: ${url}`);
  const courier = detectCourierFromUrl(url);
  const res = await fetchUrl(url).catch(() => ({ body: '' }));
  const result = parseHtmlFallback(res.body, courier);
  result.courier = courier;
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeStatus(raw) {
  if (!raw) return 'In Transit';
  const s = raw.toLowerCase();
  if (s.includes('delivered') && !s.includes('out for')) return 'Delivered';
  if (s.includes('out for delivery') || s.includes('out_for_delivery')) return 'Out for Delivery';
  if (s.includes('in transit') || s.includes('intransit') || s.includes('in_transit')) return 'In Transit';
  if (s.includes('exception') || s.includes('failed') || s.includes('undelivered')) return 'Exception';
  if (s.includes('picked up') || s.includes('pickup')) return 'Picked Up';
  if (s.includes('booked') || s.includes('created') || s.includes('info')) return 'Info Received';
  return raw;
}

module.exports = { scrapeTrackingUrl };
