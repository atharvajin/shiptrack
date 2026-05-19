const { getSupabase } = require('../lib/supabase');
const { handleCors } = require('../lib/cors');
const { parseTrackingLink, detectCourierFromUrl } = require('../lib/parser');
const { scrapeTrackingUrl } = require('../lib/scraper');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const pathParts = Array.isArray(req.query.order_path)
      ? req.query.order_path
      : String(req.query.order_path || '').split('/').filter(Boolean);

    const order_id = pathParts[0];
    const action = pathParts[1] || null;

    if (!order_id) {
      return res.status(400).json({ error: 'order_id is required' });
    }

    if (req.method === 'GET' && !action) return getOrder(req, res, order_id);
    if (req.method === 'POST' && action === 'add-tracking') return addTracking(req, res, order_id);
    if (req.method === 'POST' && action === 'refresh-tracking') return refreshTracking(req, res, order_id);
    if (req.method === 'PUT' && action === 'update-tracking') return updateTracking(req, res, order_id);
    if (req.method === 'DELETE' && !action) return deleteTracking(req, res, order_id);

    return res.status(404).json({ error: 'Route not found' });
  } catch (err) {
    console.error('[orders route error]', err);
    return res.status(500).json({
      error: 'Internal server error',
      details: err.message,
    });
  }
};

async function getOrder(req, res, order_id) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('orders')
    .select('order_id, customer_name, items, created_at, shipments(*)')
    .eq('order_id', order_id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Order not found' });
  }

  return res.json({ order: formatOrder(data) });
}

async function addTracking(req, res, order_id) {
  const { tracking_link } = req.body || {};

  if (!tracking_link) {
    return res.status(400).json({ error: 'tracking_link is required' });
  }

  const cleanLink = tracking_link.trim();

  try {
    new URL(cleanLink);
  } catch (_) {
    return res.status(422).json({
      error: 'Invalid URL — paste the full https:// link from the courier website',
    });
  }

  const supabase = getSupabase();

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('order_id')
    .eq('order_id', order_id)
    .single();

  if (orderError || !order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const parsed = parseTrackingLink(cleanLink);
  const tracking_id = parsed.tracking_id || extractIdFromUrl(cleanLink);
  const courier = parsed.courier || detectCourierFromUrl(cleanLink);

  const { error: upsertError } = await supabase.from('shipments').upsert(
    {
      order_id,
      tracking_id,
      courier,
      tracking_link: cleanLink,
      last_status: 'Pending',
      current_location: null,
      estimated_delivery: null,
      last_updated: new Date().toISOString(),
      raw_history: [],
    },
    { onConflict: 'order_id' }
  );

  if (upsertError) {
    return res.status(500).json({
      error: 'Failed to save tracking link',
      details: upsertError.message,
    });
  }

  return res.status(201).json({
    order_id,
    tracking_id,
    courier,
    status: 'Pending',
    tracking_link: cleanLink,
    message: 'Tracking link saved successfully. Click refresh tracking to try scraping latest status.',
  });
}

async function updateTracking(req, res, order_id) {
  return addTracking(req, res, order_id);
}

async function refreshTracking(req, res, order_id) {
  const supabase = getSupabase();

  const { data: shipment, error } = await supabase
    .from('shipments')
    .select('*')
    .eq('order_id', order_id)
    .single();

  if (error || !shipment) {
    return res.status(404).json({ error: 'No tracking found for this order' });
  }

  try {
    const scraped = await scrapeTrackingUrl(shipment.tracking_link);

    const { error: updateError } = await supabase
      .from('shipments')
      .update({
        courier: scraped.courier || shipment.courier,
        last_status: scraped.status || shipment.last_status || 'Pending',
        current_location: scraped.location || null,
        estimated_delivery: scraped.estimated_delivery || null,
        last_updated: new Date().toISOString(),
        raw_history: scraped.history || [],
      })
      .eq('order_id', order_id);

    if (updateError) {
      return res.status(500).json({
        error: 'Failed to update tracking data',
        details: updateError.message,
      });
    }

    return res.json({
      order_id,
      tracking_id: shipment.tracking_id,
      courier: scraped.courier || shipment.courier,
      status: scraped.status || shipment.last_status || 'Pending',
      current_location: scraped.location || null,
      estimated_delivery: scraped.estimated_delivery || null,
      history: scraped.history || [],
      last_updated: new Date().toISOString(),
      source: 'scraped',
    });
  } catch (err) {
    console.error('[refresh-tracking] scrape failed:', err);

    return res.status(200).json({
      order_id,
      tracking_id: shipment.tracking_id,
      courier: shipment.courier,
      status: shipment.last_status || 'Pending',
      current_location: shipment.current_location,
      estimated_delivery: shipment.estimated_delivery,
      history: safeJson(shipment.raw_history, []),
      last_updated: shipment.last_updated,
      source: 'last_known',
      warning: 'Live scraping failed. Showing last saved status.',
      details: err.message,
    });
  }
}

async function deleteTracking(req, res, order_id) {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('shipments')
    .delete()
    .eq('order_id', order_id);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ message: 'Tracking removed successfully' });
}

function extractIdFromUrl(url) {
  try {
    const u = new URL(url);

    for (const [, value] of u.searchParams) {
      if (/^[A-Z0-9]{8,30}$/i.test(value)) return value.toUpperCase();
    }

    const parts = u.pathname.split('/').filter(Boolean).reverse();
    for (const part of parts) {
      if (/^[A-Z0-9]{8,30}$/i.test(part)) return part.toUpperCase();
    }
  } catch (_) {}

  return 'UNKNOWN';
}

function formatOrder(row) {
  const shipment = row.shipments?.[0] || row.shipments;

  return {
    order_id: row.order_id,
    customer_name: row.customer_name,
    items: row.items,
    created_at: row.created_at,
    shipment: shipment
      ? {
          tracking_id: shipment.tracking_id,
          courier: shipment.courier,
          tracking_link: shipment.tracking_link,
          status: shipment.last_status,
          current_location: shipment.current_location,
          estimated_delivery: shipment.estimated_delivery,
          last_updated: shipment.last_updated,
          history: safeJson(shipment.raw_history, []),
        }
      : null,
  };
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}
