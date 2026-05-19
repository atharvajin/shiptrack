const { getSupabase } = require('../lib/supabase');
const { handleCors }  = require('../lib/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const supabase = getSupabase();

    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        order_id, customer_name, items, created_at,
        shipments (
          tracking_id, courier, tracking_link,
          last_status, current_location, estimated_delivery,
          last_updated, raw_history
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ orders: orders.map(formatOrder) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch orders', details: err.message });
  }
};

function formatOrder(row) {
  const s = row.shipments?.[0];
  return {
    order_id:      row.order_id,
    customer_name: row.customer_name,
    items:         row.items,
    created_at:    row.created_at,
    shipment: s ? {
      tracking_id:        s.tracking_id,
      courier:            s.courier,
      tracking_link:      s.tracking_link,
      status:             s.last_status,
      current_location:   s.current_location,
      estimated_delivery: s.estimated_delivery,
      last_updated:       s.last_updated,
      history:            safeJson(s.raw_history, []),
    } : null,
  };
}

function safeJson(v, fallback) {
  if (!v) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
