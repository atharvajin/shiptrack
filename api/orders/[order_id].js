const { getSupabase } = require("../lib/supabase");
const { handleCors } = require("../lib/cors");

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  try {
    const { order_id } = req.query;

    if (!order_id) {
      return res.status(400).json({
        error: "order_id is required",
      });
    }

    if (req.method === "GET") {
      return getOrder(req, res, order_id);
    }

    if (req.method === "DELETE") {
      return deleteOrder(req, res, order_id);
    }

    return res.status(405).json({
      error: "Method not allowed",
      allowed_methods: ["GET", "DELETE"],
    });
  } catch (err) {
    console.error("[order detail error]", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
};

async function getOrder(req, res, order_id) {
  const supabase = getSupabase();

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("order_id, customer_name, items, created_at")
    .eq("order_id", order_id)
    .single();

  if (orderError || !order) {
    return res.status(404).json({
      error: "Order not found",
      order_id,
      details: orderError?.message,
    });
  }

  const { data: shipment, error: shipmentError } = await supabase
    .from("shipments")
    .select(
      `
      order_id,
      tracking_id,
      courier,
      tracking_link,
      last_status,
      current_location,
      estimated_delivery,
      last_updated,
      raw_history
    `
    )
    .eq("order_id", order_id)
    .maybeSingle();

  if (shipmentError) {
    return res.status(500).json({
      error: "Failed to fetch shipment",
      details: shipmentError.message,
    });
  }

  return res.status(200).json({
    order: formatOrder(order, shipment),
  });
}

async function deleteOrder(req, res, order_id) {
  const supabase = getSupabase();

  await supabase.from("shipments").delete().eq("order_id", order_id);

  const { error } = await supabase
    .from("orders")
    .delete()
    .eq("order_id", order_id);

  if (error) {
    return res.status(500).json({
      error: "Failed to delete order",
      details: error.message,
    });
  }

  return res.status(200).json({
    message: "Order deleted successfully",
    order_id,
  });
}

function formatOrder(order, shipment) {
  return {
    order_id: order.order_id,
    customer_name: order.customer_name,
    items: order.items,
    created_at: order.created_at,
    shipment: shipment
      ? {
          tracking_id: shipment.tracking_id,
          courier: shipment.courier,
          tracking_link: shipment.tracking_link,
          status: shipment.last_status || "Pending",
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

  if (Array.isArray(value)) return value;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}