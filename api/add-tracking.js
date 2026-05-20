const { getSupabase } = require("./lib/supabase");
const { handleCors } = require("./lib/cors");
const { requireApiKey } = require("./lib/auth");
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

  if (!requireApiKey(req, res)) return;

  try {
    const { order_id, tracking_link } = req.body || {};

    if (!order_id) {
      return res.status(400).json({ error: "order_id is required" });
    }

    if (!tracking_link) {
      return res.status(400).json({ error: "tracking_link is required" });
    }

    const cleanOrderId = String(order_id).trim();
    const cleanLink = String(tracking_link).trim();

    try {
      const parsedUrl = new URL(cleanLink);

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res.status(422).json({
          error: "Invalid URL. Paste the full https:// courier tracking link.",
        });
      }
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

    const fallbackTrackingId =
      parsed.tracking_id || extractTrackingIdFromUrl(cleanLink);

    const fallbackCourier = parsed.courier || detectCourierFromUrl(cleanLink);

    let scraped = {
      status: "Pending",
      location: null,
      estimated_delivery: null,
      history: [],
      courier: fallbackCourier,
    };

    let scrape_ok = false;
    let scrape_error = null;

    try {
      scraped = await scrapeTrackingUrl(cleanLink);
      scrape_ok = !!scraped.status && scraped.status !== "Pending";
    } catch (err) {
      scrape_error = err.message;
      console.warn("[add-tracking scrape failed]", err.message);
    }

    const finalStatus = normalizeAppStatus(scraped.status || "Pending");
    const finalCourier = scraped.courier || fallbackCourier;
    const finalTrackingId = fallbackTrackingId;
    const finalHistory = Array.isArray(scraped.history) ? scraped.history : [];
    const finalEstimatedDelivery = normalizeDate(scraped.estimated_delivery);

    const { error: upsertError } = await supabase.from("shipments").upsert(
      {
        order_id: cleanOrderId,
        tracking_id: finalTrackingId,
        courier: finalCourier,
        tracking_link: cleanLink,
        last_status: finalStatus,
        current_location: scraped.location || null,
        estimated_delivery: finalEstimatedDelivery,
        last_updated: new Date().toISOString(),
        raw_history: finalHistory,
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

    return res.status(200).json({
      success: true,
      message: "Tracking saved successfully",
      order_id: cleanOrderId,
      tracking_id: finalTrackingId,
      courier: finalCourier,
      status: finalStatus,
      current_location: scraped.location || null,
      estimated_delivery: finalEstimatedDelivery,
      history: finalHistory,
      tracking_link: cleanLink,
      scrape_ok,
      scrape_error,
      note:
        finalStatus === "Pending"
          ? "Tracking URL was saved, but live courier status could not be extracted automatically."
          : "Live courier status was extracted and saved.",
    });
  } catch (err) {
    console.error("[add-tracking error]", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
};

function extractTrackingIdFromUrl(url) {
  try {
    const u = new URL(url);

    for (const [, value] of u.searchParams) {
      if (/^[A-Z0-9]{8,35}$/i.test(value)) {
        return value.toUpperCase();
      }
    }

    const parts = u.pathname.split("/").filter(Boolean).reverse();

    for (const part of parts) {
      if (/^[A-Z0-9]{8,35}$/i.test(part)) {
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

  if (s.includes("out for delivery") || s.includes("out-for-delivery")) {
    return "Out for Delivery";
  }

  if (s === "ofd" || s.includes(" with delivery agent")) {
    return "Out for Delivery";
  }

  if (s.includes("delivered") && !s.includes("out for delivery")) {
    return "Delivered";
  }

  if (
    s.includes("in transit") ||
    s.includes("reached") ||
    s.includes("arrived") ||
    s.includes("departed") ||
    s.includes("hub") ||
    s.includes("facility") ||
    s.includes("picked up") ||
    s.includes("dispatched")
  ) {
    return "In Transit";
  }

  if (
    s.includes("exception") ||
    s.includes("failed") ||
    s.includes("attempted") ||
    s.includes("undelivered") ||
    s.includes("unable to deliver")
  ) {
    return "Exception";
  }

  if (
    s.includes("pending") ||
    s.includes("created") ||
    s.includes("info received") ||
    s.includes("booked") ||
    s.includes("manifest")
  ) {
    return "Pending";
  }

  return status;
}