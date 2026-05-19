const { getSupabase }       = require('../../lib/supabase');
const { handleCors }        = require('../../lib/cors');
const { parseTrackingLink, detectCourierFromUrl } = require('../../lib/parser');
const { scrapeTrackingUrl } = require('../../lib/scraper');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const pathParts = Array.isArray(req.query.order_path)
    ? req.query.order_path
    : String(req.query.order_path || '').split('/').filter(Boolean);

  const order_id = pathParts[0];
  const action = pathParts[1] || null;

  if (!order_id) {
    return res.status(400).json({ error: 'order_id is required' });
  }

  // Supported routes:
  // GET    /api/orders/:order_id
  // POST   /api/orders/:order_id/add-tracking
  // POST   /api/orders/:order_id/refresh-tracking
  // PUT    /api/orders/:order_id/update-tracking
  // DELETE /api/orders/:order_id
  if (req.method === 'GET' && !action) return getOrder(req, res, order_id);
  if (req.method === 'POST' && action === 'add-tracking') return addTracking(req, res, order_id);
  if (req.method === 'POST' && action === 'refresh-tracking') return refreshTracking(req, res, order_id);
  if (req.method === 'PUT' && action === 'update-tracking') return updateTracking(req, res, order_id);
  if (req.method === 'DELETE' && !action) return deleteTracking(req, res, order_id);

  return res.status(404).json({ error: 'Route not found' });
};

// ─── GET single order ─────────────────────────────────────────────────────────
async function getOrder(req, res, order_id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select(`order_id, customer_name, items, created_at, shipments(*)`)
    .eq('order_id', order_id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Order not found' });
  res.json(formatOrder(data));
}

// ─── POST add-tracking ────────────────────────────────────────────────────────
async function addTracking(req, res, order_id) {
  const { tracking_link } = req.body || {};
  if (!tracking_link) return res.status(400).json({ error: 'tracking_link is required' });

  try { new URL(tracking_link.trim()); }
  catch (_) { return res.status(422).json({ error: 'Invalid URL — paste the full https:// link from the courier website' }); }

  const supabase = getSupabase();

  // Check order exists
  const { data: order } = await supabase.from('orders').select('order_id').eq('order_id', order_id).single();
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Check for duplicate
  const { data: existing } = await supabase.from('shipments').select('tracking_id').eq('order_id', order_id).single();
  if (existing) return res.status(409).json({ error: 'Tracking already added for this order', tip: 'Use update-tracking to replace it' });

  try {
    const scraped    = await scrapeTrackingUrl(tracking_link.trim());
    const parsed     = parseTrackingLink(tracking_link.trim());
    const tracking_id = parsed.tracking_id || extractIdFromUrl(tracking_link);

    const { error: insertErr } = await supabase.from('shipments').insert({
      order_id,
      tracking_id,
      courier:            scraped.courier,
      tracking_link:      tracking_link.trim(),
      last_status:        scraped.status,
      current_location:   scraped.location,
      estimated_delivery: scraped.estimated_delivery,
      last_updated:       new Date().toISOString(),
      raw_history:        scraped.history || [],
    });

    if (insertErr) throw insertErr;

    res.status(201).json({
      order_id, tracking_id, courier: scraped.courier,
      status: scraped.status, estimated_delivery: scraped.estimated_delivery,
      current_location: scraped.location, history: scraped.history,
      last_updated: new Date().toISOString(), source: 'scraped',
    });

  } catch (err) {
    console.error('[add-tracking] scrape failed:', err.message);
    // Save URL anyway — will retry on next refresh
    const parsed = parseTrackingLink(tracking_link.trim());
    await supabase.from('shipments').upsert({
      order_id,
      tracking_id:   parsed.tracking_id || 'UNKNOWN',
      courier:       parsed.courier     || detectCourierFromUrl(tracking_link),
      tracking_link: tracking_link.trim(),
      last_status:   'Pending',
      last_updated:  new Date().toISOString(),
      raw_history:   [],
    }, { onConflict: 'order_id', ignoreDuplicates: true });

    res.status(202).json({
      order_id, status: 'Pending',
      message: 'Tracking URL saved. Scraping failed — refresh to retry.',
      error: err.message,
    });
  }
}

// ─── PUT update-tracking ──────────────────────────────────────────────────────
async function updateTracking(req, res, order_id) {
  const { tracking_link } = req.body || {};
  if (!tracking_link) return res.status(400).json({ error: 'tracking_link is required' });
  try { new URL(tracking_link.trim()); } catch (_) { return res.status(422).json({ error: 'Invalid URL' }); }

  try {
    const supabase   = getSupabase();
    const scraped    = await scrapeTrackingUrl(tracking_link.trim());
    const parsed     = parseTrackingLink(tracking_link.trim());

    const { error } = await supabase.from('shipments').upsert({
      order_id,
      tracking_id:        parsed.tracking_id || extractIdFromUrl(tracking_link),
      courier:            scraped.courier,
      tracking_link:      tracking_link.trim(),
      last_status:        scraped.status,
      current_location:   scraped.location,
      estimated_delivery: scraped.estimated_delivery,
      last_updated:       new Date().toISOString(),
      raw_history:        scraped.history || [],
    }, { onConflict: 'order_id' });

    if (error) throw error;
    res.json({ order_id, status: scraped.status, courier: scraped.courier, current_location: scraped.location, history: scraped.history });
  } catch (err) {
    res.status(502).json({ error: 'Scraping failed', details: err.message });
  }
}

// ─── POST refresh-tracking ────────────────────────────────────────────────────
async function refreshTracking(req, res, order_id) {
  const supabase = getSupabase();
  const { data: shipment } = await supabase.from('shipments').select('*').eq('order_id', order_id).single();
  if (!shipment) return res.status(404).json({ error: 'No tracking found for this order' });

  try {
    const scraped = await scrapeTrackingUrl(shipment.tracking_link);
    await supabase.from('shipments').update({
      last_status:        scraped.status,
      current_location:   scraped.location,
      estimated_delivery: scraped.estimated_delivery,
      last_updated:       new Date().toISOString(),
      raw_history:        scraped.history || [],
    }).eq('order_id', order_id);

    res.json({ order_id, tracking_id: shipment.tracking_id, courier: scraped.courier || shipment.courier, status: scraped.status, current_location: scraped.location, history: scraped.history, last_updated: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: 'Re-scrape failed', details: err.message, last_known_status: shipment.last_status });
  }
}

// ─── DELETE tracking ──────────────────────────────────────────────────────────
async function deleteTracking(req, res, order_id) {
  const supabase = getSupabase();
  const { error } = await supabase.from('shipments').delete().eq('order_id', order_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Tracking removed successfully' });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractIdFromUrl(url) {
  try {
    const u = new URL(url);
    for (const [, v] of u.searchParams) { if (/^[A-Z0-9]{8,25}$/i.test(v)) return v.toUpperCase(); }
    for (const p of u.pathname.split('/').filter(Boolean).reverse()) { if (/^[A-Z0-9]{8,25}$/i.test(p)) return p.toUpperCase(); }
  } catch (_) {}
  return 'UNKNOWN';
}

function formatOrder(row) {
  const s = row.shipments?.[0] || row.shipments;
  return {
    order_id: row.order_id, customer_name: row.customer_name,
    items: row.items, created_at: row.created_at,
    shipment: s ? {
      tracking_id: s.tracking_id, courier: s.courier, tracking_link: s.tracking_link,
      status: s.last_status, current_location: s.current_location,
      estimated_delivery: s.estimated_delivery, last_updated: s.last_updated,
      history: Array.isArray(s.raw_history) ? s.raw_history : safeJson(s.raw_history, []),
    } : null,
  };
}

function safeJson(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}
