/**
 * Comprehensive HTTP-based tracking scraper
 * Covers all shipment states for all major Indian couriers
 * Works on Vercel free tier — no Puppeteer needed
 */

const https = require('https');
const http  = require('http');
const { detectCourierFromUrl } = require('./parser');

// ─── All possible shipment states ─────────────────────────────────────────────
const STATUS_MAP = [
  // Delivered
  { keywords: ['delivered', 'delivery successful', 'shipment delivered', 'delivered successfully', 'package delivered'], status: 'Delivered' },

  // Out for Delivery
  { keywords: ['out for delivery', 'out-for-delivery', 'ofd', 'with delivery agent', 'with courier', 'on the way', 'dispatched for delivery', 'sent for delivery', 'loaded for delivery'], status: 'Out for Delivery' },

  // Attempted Delivery
  { keywords: ['delivery attempted', 'attempt failed', 'delivery failed', 'not delivered', 'undelivered', 'delivery exception', 'unable to deliver', 'delivery unsuccessful', 'could not deliver', 'recipient not available', 'door locked', 'premises closed'], status: 'Delivery Attempted' },

  // Out of Delivery Area
  { keywords: ['out of delivery area', 'unserviceable', 'non serviceable', 'outside delivery zone'], status: 'Unserviceable' },

  // Dispatched / Shipped
  { keywords: ['dispatched', 'shipment dispatched', 'order dispatched', 'handed over to courier', 'handed to courier', 'consignment dispatched', 'shipped'], status: 'Dispatched' },

  // Picked Up
  { keywords: ['picked up', 'pickup done', 'shipment picked', 'collected from seller', 'package picked', 'picked from origin'], status: 'Picked Up' },

  // In Transit
  { keywords: ['in transit', 'intransit', 'in-transit', 'on the way to', 'reached hub', 'arrived at hub', 'arrived at facility', 'departed from', 'departure scan', 'arrival scan', 'at sorting center', 'at facility', 'received at', 'connecting flight', 'customs cleared', 'out of customs', 'in customs', 'reached destination hub', 'reached origin hub', 'reached city hub', 'connected to', 'forwarded to', 'misrouted'], status: 'In Transit' },

  // At Local Facility
  { keywords: ['at local facility', 'reached local hub', 'at delivery hub', 'reached delivery hub', 'at delivery center'], status: 'At Local Facility' },

  // Return / RTO
  { keywords: ['rto', 'return to origin', 'returning to seller', 'return initiated', 'return in transit', 'return dispatched', 'return picked up', 'return delivered', 'reverse pickup', 'reverse shipment'], status: 'Return to Origin' },

  // Cancelled
  { keywords: ['cancelled', 'shipment cancelled', 'order cancelled', 'canceled'], status: 'Cancelled' },

  // Lost
  { keywords: ['lost', 'shipment lost', 'missing shipment'], status: 'Lost' },

  // Damaged
  { keywords: ['damaged', 'shipment damaged', 'package damaged'], status: 'Damaged' },

  // Held / Stuck
  { keywords: ['held', 'on hold', 'shipment held', 'withheld', 'detained', 'awaiting clearance', 'pending clearance', 'stuck'], status: 'On Hold' },

  // Info Received / Booked
  { keywords: ['info received', 'information received', 'order placed', 'shipment created', 'label created', 'booking confirmed', 'manifest generated', 'booked', 'created', 'registered', 'order received', 'order booked'], status: 'Info Received' },
];

function normalizeStatus(raw) {
  if (!raw) return 'In Transit';
  const lower = raw.toLowerCase().trim();

  for (const { keywords, status } of STATUS_MAP) {
    if (keywords.some(k => lower.includes(k))) return status;
  }

  // If nothing matched, return cleaned original
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ─── HTTP fetch helper ────────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/html, */*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        'Cache-Control':   'no-cache',
        ...options.headers,
      },
      timeout: 9000,
    };

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${urlObj.protocol}//${urlObj.hostname}${res.headers.location}`;
        return fetchUrl(redirectUrl, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 9s')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── HTML scraper — works for any courier page ─────────────────────────────
function scrapeHtml(html, courierName) {
  if (!html || html.length < 100) {
    return { status: 'Pending', location: null, estimated_delivery: null, history: [] };
  }

  const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                   .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/\s+/g, ' ')
                   .trim();

  const lower = text.toLowerCase();

  // Detect status from full page text
  let status = 'In Transit';
  for (const { keywords, s } of STATUS_MAP.map(m => ({ keywords: m.keywords, s: m.status }))) {
    if (keywords.some(k => lower.includes(k))) { status = s; break; }
  }

  // Extract location — look for city/hub names near keywords
  let location = null;
  const locPatterns = [
    /(?:current location|location|at|reached|hub)[:\s]+([A-Z][a-zA-Z\s\-,]{3,40}?)(?:\.|,|\n|<)/i,
    /(?:city|centre|center|facility)[:\s]+([A-Z][a-zA-Z\s\-]{3,30}?)(?:\.|,|\n|<)/i,
  ];
  for (const p of locPatterns) {
    const m = text.match(p);
    if (m?.[1]?.trim().length > 2) { location = m[1].trim(); break; }
  }

  // Extract estimated delivery date
  let edd = null;
  const eddPatterns = [
    /(?:expected|estimated|deliver by|delivery by|eta)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(?:expected|estimated|deliver by)[:\s]+(\d{1,2}\s+\w{3,9}\s+\d{4})/i,
    /(?:by|before)\s+(\d{1,2}\s+\w{3,9}\s+\d{4})/i,
  ];
  for (const p of eddPatterns) {
    const m = text.match(p);
    if (m?.[1]) { edd = m[1].trim(); break; }
  }

  // Extract history from HTML tables
  const history = [];
  const tableRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = tableRowRegex.exec(html)) !== null) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (cells.length >= 2 && cells[1].length > 3 && !/^(date|time|status|location|event|description)$/i.test(cells[0])) {
      history.push({
        timestamp: cells[0] || null,
        message:   cells[1] || null,
        location:  cells[2] || null,
        status:    normalizeStatus(cells[1]),
      });
    }
  }

  // Also try list-based timelines (div/li patterns)
  if (history.length === 0) {
    const timelineRegex = /(?:class="[^"]*(?:track|timeline|event|scan|checkpoint)[^"]*")[^>]*>([\s\S]{10,300}?)(?=class="[^"]*(?:track|timeline|event|scan|checkpoint)|<\/[ou]l>)/gi;
    let tlMatch;
    while ((tlMatch = timelineRegex.exec(html)) !== null) {
      const cleaned = tlMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned.length > 5) {
        history.push({ timestamp: null, message: cleaned.slice(0, 200), location: null, status: normalizeStatus(cleaned) });
      }
    }
  }

  return { status, location, estimated_delivery: edd, history: history.slice(0, 20) };
}

// ─── Courier-specific API strategies ─────────────────────────────────────────
const STRATEGIES = [

  // ── Ekart / Flipkart ───────────────────────────────────────────────────────
  {
    name: 'Ekart',
    match: /ekartlogistics\.com/i,
    scrape: async (url) => {
      // Extract tracking ID from URL
      const id = url.split('/').filter(Boolean).pop()?.split('?')[0];
      if (!id) throw new Error('No tracking ID in Ekart URL');

      // Try Ekart tracking API
      const apiUrl = `https://ekartlogistics.com/shipmenttrack/${id}`;
      const res = await fetchUrl(apiUrl, { headers: { 'Accept': 'application/json, text/html' } });

      // Try JSON parse first
      try {
        const data = JSON.parse(res.body);
        const events = data?.ShipmentSummary || data?.trackDetails || data?.events || [];
        const last   = events[events.length - 1] || {};
        return {
          status:             normalizeStatus(last?.status || last?.scanType || data?.status),
          location:           last?.location || last?.city || null,
          estimated_delivery: data?.edd || data?.estimatedDelivery || null,
          history: events.map(e => ({
            timestamp: e.date || e.timestamp || e.scanDate || null,
            message:   e.status || e.scanType || e.description || e.activity || null,
            location:  e.location || e.city || e.hub || null,
            status:    normalizeStatus(e.status || e.scanType || ''),
          })).filter(e => e.message),
        };
      } catch (_) {
        return scrapeHtml(res.body, 'Ekart');
      }
    },
  },

  // ── Delhivery ──────────────────────────────────────────────────────────────
  {
    name: 'Delhivery',
    match: /delhivery\.com/i,
    scrape: async (url) => {
      const waybill = url.match(/wbn=([A-Z0-9]+)/i)?.[1] ||
                      url.split('/').filter(Boolean).pop()?.split('?')[0];
      if (!waybill) throw new Error('No waybill in Delhivery URL');

      const res = await fetchUrl(
        `https://api.delhivery.com/v3/track?wbn=${waybill}`,
        { headers: { 'Accept': 'application/json' } }
      );

      try {
        const data = JSON.parse(res.body);
        const pkg  = data?.ShipmentData?.[0]?.Shipment || {};
        const scans = (pkg?.Scans || []).reverse();
        const last  = scans[scans.length - 1]?.ScanDetail || {};
        return {
          status:             normalizeStatus(pkg?.Status?.Status || last?.Scan),
          location:           last?.ScanLocation || pkg?.Status?.ScanLocation || null,
          estimated_delivery: pkg?.ExpectedDeliveryDate || null,
          history: scans.map(s => ({
            timestamp: s.ScanDetail?.ScanDateTime || null,
            message:   s.ScanDetail?.Instructions || s.ScanDetail?.Scan || null,
            location:  s.ScanDetail?.ScanLocation || null,
            status:    normalizeStatus(s.ScanDetail?.Scan || ''),
          })).filter(e => e.message),
        };
      } catch (_) {
        const htmlRes = await fetchUrl(url);
        return scrapeHtml(htmlRes.body, 'Delhivery');
      }
    },
  },

  // ── Shiprocket ─────────────────────────────────────────────────────────────
  {
    name: 'Shiprocket',
    match: /shiprocket\.in/i,
    scrape: async (url) => {
      const awb = url.match(/awb=([A-Z0-9]+)/i)?.[1] ||
                  url.match(/\/tracking\/([A-Z0-9]+)/i)?.[1];
      if (!awb) throw new Error('No AWB in Shiprocket URL');

      const res = await fetchUrl(
        `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
        { headers: { 'Accept': 'application/json' } }
      );

      try {
        const data       = JSON.parse(res.body);
        const tracking   = data?.tracking_data || {};
        const shipment   = tracking?.shipment_track?.[0] || {};
        const activities = (tracking?.shipment_track_activities || []);
        return {
          status:             normalizeStatus(shipment?.current_status || tracking?.track_status),
          location:           activities[0]?.location || shipment?.origin || null,
          estimated_delivery: shipment?.edd || null,
          history: activities.map(a => ({
            timestamp: a.date || null,
            message:   a.activity || a.status || null,
            location:  a.location || null,
            status:    normalizeStatus(a.activity || a.status || ''),
          })).filter(e => e.message),
        };
      } catch (_) {
        const htmlRes = await fetchUrl(url);
        return scrapeHtml(htmlRes.body, 'Shiprocket');
      }
    },
  },

  // ── BlueDart ───────────────────────────────────────────────────────────────
  {
    name: 'BlueDart',
    match: /bluedart\.com/i,
    scrape: async (url) => {
      const waybill = url.match(/waybill=(\d+)/i)?.[1];
      if (!waybill) throw new Error('No waybill in BlueDart URL');

      // BlueDart has a SOAP API — try their tracking page directly
      const res = await fetchUrl(
        `https://www.bluedart.com/tracking?waybill=${waybill}`,
        { headers: { 'Accept': 'text/html' } }
      );
      return scrapeHtml(res.body, 'BlueDart');
    },
  },

  // ── DTDC ───────────────────────────────────────────────────────────────────
  {
    name: 'DTDC',
    match: /dtdc\.com/i,
    scrape: async (url) => {
      const trackNum = url.match(/trackingno=([A-Z0-9]+)/i)?.[1];
      if (!trackNum) throw new Error('No tracking number in DTDC URL');

      const res = await fetchUrl(
        `https://tracking.dtdc.com/ctbs-tracking/customerInterface.tr?submitName=getLoadPgFrmExternal&cnNo=${trackNum}&cType=JSON`,
        { headers: { 'Accept': 'application/json, text/html' } }
      );

      try {
        const data  = JSON.parse(res.body);
        const scans = data?.trackingDetails || data?.scanList || [];
        const last  = scans[scans.length - 1] || {};
        return {
          status:             normalizeStatus(last?.status || last?.scanType),
          location:           last?.location || last?.city || null,
          estimated_delivery: null,
          history: scans.map(s => ({
            timestamp: s.date || s.time || null,
            message:   s.status || s.scanType || s.remarks || null,
            location:  s.location || s.city || null,
            status:    normalizeStatus(s.status || s.scanType || ''),
          })).filter(e => e.message),
        };
      } catch (_) {
        const htmlRes = await fetchUrl(url);
        return scrapeHtml(htmlRes.body, 'DTDC');
      }
    },
  },

  // ── Ecom Express ──────────────────────────────────────────────────────────
  {
    name: 'Ecom Express',
    match: /ecomexpress\.in/i,
    scrape: async (url) => {
      const awb = url.match(/awb_number=(\d+)/i)?.[1] ||
                  url.match(/\/tracking\/(\d+)/i)?.[1];
      if (!awb) throw new Error('No AWB in Ecom Express URL');

      const res = await fetchUrl(
        `https://ecomexpress.in/tracking/?awb_number=${awb}`,
        { headers: { 'Accept': 'text/html' } }
      );
      return scrapeHtml(res.body, 'Ecom Express');
    },
  },

  // ── Xpressbees ────────────────────────────────────────────────────────────
  {
    name: 'Xpressbees',
    match: /xpressbees\.com/i,
    scrape: async (url) => {
      const awb = url.match(/awb=(\d+)/i)?.[1] ||
                  url.match(/\/tracking\/(\d+)/i)?.[1];
      if (!awb) throw new Error('No AWB in Xpressbees URL');

      const res = await fetchUrl(
        `https://www.xpressbees.com/shipment/tracking/?awb=${awb}`,
        { headers: { 'Accept': 'text/html' } }
      );
      return scrapeHtml(res.body, 'Xpressbees');
    },
  },

  // ── India Post ────────────────────────────────────────────────────────────
  {
    name: 'India Post',
    match: /indiapost\.gov\.in/i,
    scrape: async (url) => {
      const id = url.match(/consignment_id=([A-Z0-9]+)/i)?.[1] ||
                 url.match(/([A-Z]{2}\d{9}IN)/)?.[1];
      if (!id) throw new Error('No consignment ID in India Post URL');

      const res = await fetchUrl(
        `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/TrackConsignment.aspx?scode=${id}`,
        { headers: { 'Accept': 'text/html' } }
      );
      return scrapeHtml(res.body, 'India Post');
    },
  },

  // ── FedEx ─────────────────────────────────────────────────────────────────
  {
    name: 'FedEx',
    match: /fedex\.com/i,
    scrape: async (url) => {
      const trackNum = url.match(/tracknumbers=(\d+)/i)?.[1] ||
                       url.match(/trackingNumber=(\d+)/i)?.[1];
      if (!trackNum) throw new Error('No tracking number in FedEx URL');

      const res = await fetchUrl(
        `https://www.fedex.com/fedextrack/?trknbr=${trackNum}`,
        { headers: { 'Accept': 'text/html' } }
      );
      return scrapeHtml(res.body, 'FedEx');
    },
  },

  // ── DHL ───────────────────────────────────────────────────────────────────
  {
    name: 'DHL',
    match: /dhl\.com/i,
    scrape: async (url) => {
      const id = url.match(/tracking-id=([A-Z0-9]+)/i)?.[1] ||
                 url.match(/\/([A-Z0-9]{10,20})\/?$/i)?.[1];
      if (!id) throw new Error('No tracking ID in DHL URL');

      const res = await fetchUrl(
        `https://api.dhl.com/track/shipments?trackingNumber=${id}`,
        { headers: { 'Accept': 'application/json', 'DHL-API-Key': 'demo-key' } }
      );

      try {
        const data   = JSON.parse(res.body);
        const ship   = data?.shipments?.[0] || {};
        const events = ship?.events || [];
        return {
          status:             normalizeStatus(ship?.status?.description || ship?.status?.code),
          location:           ship?.status?.location?.address?.addressLocality || null,
          estimated_delivery: ship?.estimatedTimeOfDelivery || null,
          history: events.map(e => ({
            timestamp: e.timestamp || null,
            message:   e.description || e.status || null,
            location:  e.location?.address?.addressLocality || null,
            status:    normalizeStatus(e.description || ''),
          })).filter(e => e.message),
        };
      } catch (_) {
        const htmlRes = await fetchUrl(url);
        return scrapeHtml(htmlRes.body, 'DHL');
      }
    },
  },

  // ── Shadowfax ─────────────────────────────────────────────────────────────
  {
    name: 'Shadowfax',
    match: /shadowfax\.in/i,
    scrape: async (url) => {
      const res = await fetchUrl(url, { headers: { 'Accept': 'text/html' } });
      return scrapeHtml(res.body, 'Shadowfax');
    },
  },

  // ── Amazon Logistics / I Have Shipped ─────────────────────────────────────
  {
    name: 'Amazon Logistics',
    match: /amazon\.(in|com).*track/i,
    scrape: async (url) => {
      const res = await fetchUrl(url, { headers: { 'Accept': 'text/html' } });
      return scrapeHtml(res.body, 'Amazon Logistics');
    },
  },
];

// ─── Main exported function ───────────────────────────────────────────────────
async function scrapeTrackingUrl(url) {
  if (!url) throw new Error('URL is required');

  const strategy = STRATEGIES.find(s => s.match.test(url));

  if (strategy) {
    console.log(`[Scraper] Using ${strategy.name} strategy`);
    try {
      const result   = await strategy.scrape(url);
      result.courier = strategy.name;
      result.status  = normalizeStatus(result.status);
      result.history = (result.history || []).filter(h => h.message?.length > 2);
      console.log(`[Scraper] ✓ ${strategy.name}: ${result.status} @ ${result.location || 'unknown'}`);
      return result;
    } catch (err) {
      console.warn(`[Scraper] ${strategy.name} failed (${err.message}) — trying direct HTML`);
      try {
        const res    = await fetchUrl(url);
        const result = scrapeHtml(res.body, strategy.name);
        result.courier = strategy.name;
        return result;
      } catch (err2) {
        console.error(`[Scraper] HTML fallback also failed: ${err2.message}`);
        return { status: 'Pending', location: null, estimated_delivery: null, history: [], courier: strategy.name };
      }
    }
  }

  // Unknown courier — try direct HTML scrape
  console.log(`[Scraper] Unknown courier — trying generic HTML scrape`);
  const courier = detectCourierFromUrl(url);
  try {
    const res    = await fetchUrl(url);
    const result = scrapeHtml(res.body, courier);
    result.courier = courier;
    return result;
  } catch (err) {
    console.error(`[Scraper] Generic scrape failed: ${err.message}`);
    return { status: 'Pending', location: null, estimated_delivery: null, history: [], courier };
  }
}

module.exports = { scrapeTrackingUrl, normalizeStatus };
