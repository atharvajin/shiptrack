const { getSupabase } = require('../lib/supabase');
const { handleCors } = require('../lib/cors');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { order_id } = req.query;

    if (!order_id) {
      return res.status(400).json({
        error: 'order_id is required',
      });
    }

    if (req.method === 'GET') {
      return getOrder(req, res, order_id);
    }

    if (req.method === 'DELETE') {
      return deleteOrder(req, res, order_id);
    }

    return res.status(405).json({
      error: 'Method not allowed',
      allowed_methods: ['GET', 'DELETE'],
    });
  } catch (err) {
    console.error('[order detail error]', err);

    return res.status(500).json({
      error: 'Internal server error',
      details: err.message,
    });
  }
};

async function getOrder(req, res, order_id) {
  const supabase = getSupabase();

  const { data: order, error } = await supabase
    .from('orders')
    .select(`
      order_id,
      customer_name,
      items,
      created_at,
      shipments (
        tracking_id,
        courier,
        tracking_link,
        last_status,
        current_location,
        estimated_delivery,
        last_updated,
        raw_history
      )
    `)
    .eq('order_id', order_id)
    .single();

  if (error || !order) {
    return res.status(404).json({
      error: 'Order not found',
      order_id,
    });
  }

  return res.status(200).json({
    order: formatOrder(order),
  });
}

async function deleteOrder(req, res, order_id) {
  const supabase = getSupabase();

  const { error: shipmentError } = await supabase
    .from('shipments')
    .delete()
    .eq('order_id', order_id);

  if (shipmentError) {
    return res.status(500).json({
      error: 'Failed to delete shipment data',
      details: shipmentError.message,
    });
  }

  const { error: orderError } = await supabase
    .from('orders')
    .delete()
    .eq('order_id', order_id);

  if (orderError) {
    return res.status(500).json({
      error: 'Failed to delete order',
      details: orderError.message,
    });
  }

  return res.status(200).json({
    message: 'Order deleted successfully',
    order_id,
  });
}

function formatOrder(row) {
  const shipment = Array.isArray(row.shipments)
    ? row.shipments[0]
    : row.shipments;

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

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}