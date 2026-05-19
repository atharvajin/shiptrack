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
    if (req.method === "GET") {
      return getOrders(req, res);
    }

    if (req.method === "POST") {
      return createOrder(req, res);
    }

    return res.status(405).json({
      error: "Method not allowed",
      allowed_methods: ["GET", "POST"],
    });
  } catch (err) {
    console.error("[orders index error]", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
};

async function getOrders(req, res) {
  const supabase = getSupabase();

  const { data: orders, error: ordersError } = await supabase
    .from("orders")
    .select("order_id, customer_name, items, created_at")
    .order("created_at", { ascending: false });

  if (ordersError) {
    return res.status(500).json({
      error: "Failed to fetch orders",
      details: ordersError.message,
    });
  }

  const orderIds = (orders || []).map((order) => order.order_id);

  let shipments = [];

  if (orderIds.length > 0) {
    const { data: shipmentRows, error: shipmentsError } = await supabase
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
      .in("order_id", orderIds);

    if (shipmentsError) {
      return res.status(500).json({
        error: "Failed to fetch shipments",
        details: shipmentsError.message,
      });
    }

    shipments = shipmentRows || [];
  }

  const shipmentByOrderId = new Map();

  for (const shipment of shipments) {
    shipmentByOrderId.set(shipment.order_id, shipment);
  }

  const formattedOrders = (orders || []).map((order) => {
    const shipment = shipmentByOrderId.get(order.order_id);

    return formatOrder(order, shipment);
  });

  return res.status(200).json({
    orders: formattedOrders,
  });
}

async function createOrder(req, res) {
  const { order_id, customer_name, items } = req.body || {};

  if (!order_id || !customer_name || !items) {
    return res.status(400).json({
      error: "order_id, customer_name, and items are required",
    });
  }

  const cleanOrderId = String(order_id).trim();
  const cleanCustomerName = String(customer_name).trim();
  const cleanItems = String(items).trim();

  if (!cleanOrderId || !cleanCustomerName || !cleanItems) {
    return res.status(400).json({
      error: "order_id, customer_name, and items cannot be empty",
    });
  }

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("orders")
    .insert({
      order_id: cleanOrderId,
      customer_name: cleanCustomerName,
      items: cleanItems,
    })
    .select("order_id, customer_name, items, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Order ID already exists",
      });
    }

    return res.status(500).json({
      error: "Failed to create order",
      details: error.message,
    });
  }

  return res.status(201).json({
    message: "Order created successfully",
    order: formatOrder(data, null),
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