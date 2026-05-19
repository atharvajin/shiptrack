const { getSupabase } = require("./lib/supabase");
const { handleCors } = require("./lib/cors");
const { parseTrackingLink, detectCourierFromUrl } = require("./lib/parser");
const { scrapeTrackingUrl } = require("./lib/scraper");

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

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
    const trackingIdFromUrl = parsed.tracking_id || extractIdFromUrl(cleanLink);
    const courierFromUrl = parsed.courier || detectCourierFromUrl(cleanLink);

    let scraped = {
      status: "Pending",
      location: null,
      estimated_delivery: null,
      history: [],
      courier: courierFromUrl,
    };

    try {
      scraped = await scrapeTrackingUrl(cleanLink);
    } catch (scrapeError) {
      console.warn("[add-tracking scrape failed]", scrapeError.message);
    }

    const finalStatus = normalizeAppStatus(scraped.status || "Pending");
    const finalCourier = scraped.courier || courierFromUrl;
    const finalTrackingId = trackingIdFromUrl;

    const { error: upsertError } = await supabase.from("shipments").upsert(
      {
        order_id: cleanOrderId,
        tracking_id: finalTrackingId,
        courier: finalCourier,
        tracking_link: cleanLink,
        last_status: finalStatus,
        current_location: scraped.location || null,
        estimated_delivery: normalizeDate(scraped.estimated_delivery),
        last_updated: new Date().toISOString(),
        raw_history: Array.isArray(scraped.history) ? scraped.history : [],
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
      tracking_id: finalTrackingId,
      courier: finalCourier,
      status: finalStatus,
      current_location: scraped.location || null,
      estimated_delivery: normalizeDate(scraped.estimated_delivery),
      history: Array.isArray(scraped.history) ? scraped.history : [],
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

function normalizeDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().split("T")[0];
}

function normalizeAppStatus(status) {
  if (!status) return "Pending";

  const s = String(status).toLowerCase();

  if (s.includes("delivered") && !s.includes("out")) {
    return "Delivered";
  }

  if (
    s.includes("out for delivery") ||
    s.includes("out-for-delivery") ||
    s.includes("ofd") ||
    s.includes("with delivery agent")
  ) {
    return "Out for Delivery";
  }

  if (
    s.includes("transit") ||
    s.includes("reached") ||
    s.includes("arrived") ||
    s.includes("departed") ||
    s.includes("hub")
  ) {
    return "In Transit";
  }

  if (
    s.includes("exception") ||
    s.includes("failed") ||
    s.includes("attempted") ||
    s.includes("undelivered")
  ) {
    return "Exception";
  }

  if (
    s.includes("pending") ||
    s.includes("created") ||
    s.includes("info received") ||
    s.includes("booked")
  ) {
    return "Pending";
  }

  return status;
}