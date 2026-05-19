const { getSupabase } = require("./lib/supabase");
const { handleCors } = require("./lib/cors");
const { parseTrackingLink, detectCourierFromUrl } = require("./lib/parser");

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
      allowed_methods: ["POST"],
    });
  }

  try {
    const { order_id, tracking_link } = req.body || {};

    if (!order_id) {
      return res.status(400).json({
        error: "order_id is required",
      });
    }

    if (!tracking_link) {
      return res.status(400).json({
        error: "tracking_link is required",
      });
    }

    const cleanOrderId = String(order_id).trim();
    const cleanLink = String(tracking_link).trim();

    try {
      new URL(cleanLink);
    } catch (_) {
      return res.status(422).json({
        error: "Invalid URL. Paste the full https:// courier tracking link.",
      });
    }

    const supabase = getSupabase();

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("order_id")
      .eq("order_id", cleanOrderId)
      .single();

    if (orderError || !order) {
      return res.status(404).json({
        error: "Order not found",
        order_id: cleanOrderId,
      });
    }

    const parsed = parseTrackingLink(cleanLink);
    const tracking_id = parsed.tracking_id || extractIdFromUrl(cleanLink);
    const courier = parsed.courier || detectCourierFromUrl(cleanLink);

    const { error: upsertError } = await supabase.from("shipments").upsert(
      {
        order_id: cleanOrderId,
        tracking_id,
        courier,
        tracking_link: cleanLink,
        last_status: "Pending",
        current_location: null,
        estimated_delivery: null,
        last_updated: new Date().toISOString(),
        raw_history: [],
      },
      {
        onConflict: "order_id",
      }
    );

    if (upsertError) {
      return res.status(500).json({
        error: "Failed to save tracking link",
        details: upsertError.message,
      });
    }

    return res.status(201).json({
      message: "Tracking link saved successfully",
      order_id: cleanOrderId,
      tracking_id,
      courier,
      status: "Pending",
      tracking_link: cleanLink,
    });
  } catch (err) {
    console.error("[add-tracking error]", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
};

function extractIdFromUrl(url) {
  try {
    const u = new URL(url);

    for (const [, value] of u.searchParams) {
      if (/^[A-Z0-9]{8,30}$/i.test(value)) {
        return value.toUpperCase();
      }
    }

    const parts = u.pathname.split("/").filter(Boolean).reverse();

    for (const part of parts) {
      if (/^[A-Z0-9]{8,30}$/i.test(part)) {
        return part.toUpperCase();
      }
    }
  } catch (_) {}

  return "UNKNOWN";
}