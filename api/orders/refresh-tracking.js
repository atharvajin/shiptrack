const { getSupabase } = require("../lib/supabase");
const { handleCors } = require("../lib/cors");
const { requireApiKey } = require("../lib/auth");
const { parseTrackingLink, detectCourierFromUrl } = require("../lib/parser");
const { scrapeTrackingUrl } = require("../lib/scraper");

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
    const rawOrderId = req.query?.order_id;
    const orderId = Array.isArray(rawOrderId) ? rawOrderId[0] : rawOrderId;

    if (!orderId) {
      return res.status(400).json({
        error: "order_id is required",
      });
    }

    const cleanOrderId = String(orderId).trim();
    const supabase = getSupabase();

    const { data: shipment, error: shipmentError } = await supabase
      .from("shipments")
      .select("*")
      .eq("order_id", cleanOrderId)
      .single();

    if (shipmentError || !shipment) {
      return res.status(404).json({
        error: "No tracking found for this order",
        order_id: cleanOrderId,
        details: shipmentError?.message,
      });
    }

    const trackingLink = shipment.tracking_link;

    if (!trackingLink) {
      return res.status(400).json({
        error: "Tracking link is missing for this order",
      });
    }

    const parsed = parseTrackingLink(trackingLink);

    let scraped = {
      status: shipment.last_status || "Pending",
      location: shipment.current_location || null,
      estimated_delivery: shipment.estimated_delivery || null,
      history: safeJson(shipment.raw_history, []),
      courier: shipment.courier || parsed.courier || detectCourierFromUrl(trackingLink),
    };

    let scrape_ok = false;
    let scrape_error = null;

    try {
      scraped = await scrapeTrackingUrl(trackingLink);
      scrape_ok = !!scraped.status && scraped.status !== "Pending";
    } catch (err) {
      scrape_error = err.message;
      console.warn("[refresh-tracking scrape failed]", err.message);
    }

    const finalStatus = normalizeAppStatus(
      scraped.status || "Pending"
    );

    const finalCourier =
      scraped.courier ||
      shipment.courier ||
      parsed.courier ||
      detectCourierFromUrl(trackingLink);

    const finalHistory = Array.isArray(scraped.history)
      ? scraped.history
      : safeJson(shipment.raw_history, []);

    const finalEstimatedDelivery =
      normalizeDate(scraped.estimated_delivery) || shipment.estimated_delivery;

    const now = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("shipments")
      .update({
        courier: finalCourier,
        last_status: finalStatus,
        current_location: scraped.location || shipment.current_location || null,
        estimated_delivery: finalEstimatedDelivery || null,
        last_updated: now,
        raw_history: finalHistory,
      })
      .eq("order_id", cleanOrderId);

    if (updateError) {
      return res.status(500).json({
        error: "Failed to refresh tracking",
        details: updateError.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Tracking refreshed successfully",
      order_id: cleanOrderId,
      tracking_id: shipment.tracking_id,
      courier: finalCourier,
      status: finalStatus,
      current_location: scraped.location || shipment.current_location || null,
      estimated_delivery: finalEstimatedDelivery || null,
      history: finalHistory,
      tracking_link: trackingLink,
      last_updated: now,
      scrape_ok,
      scrape_error,
    });
  } catch (err) {
    console.error("[refresh-tracking error]", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
    });
  }
};

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

  if (s.includes("delivered") && !s.includes("out for delivery")) {
    return "Delivered";
  }

  if (s.includes("out for delivery") || s.includes("out-for-delivery") || s === "ofd" || s.includes(" with delivery agent")) {
    return "Out for Delivery";
  }

  if (s.includes("return to origin") || s.includes("rto") || s.includes("returning to seller")) {
    return "Return to Origin";
  }

  if (s.includes("cancelled") || s.includes("canceled")) {
    return "Cancelled";
  }

  if (s.includes("lost")) {
    return "Lost";
  }

  if (s.includes("damaged")) {
    return "Damaged";
  }

  if (s.includes("delivery attempted") || s.includes("attempt failed") || s.includes("undelivered") || s.includes("unable to deliver")) {
    return "Delivery Attempted";
  }

  if (s.includes("unserviceable")) {
    return "Unserviceable";
  }

  if (s.includes("on hold") || s.includes("held") || s.includes("detained")) {
    return "On Hold";
  }

  if (
    s.includes("in transit") ||
    s.includes("reached") ||
    s.includes("arrived") ||
    s.includes("departed") ||
    s.includes("hub") ||
    s.includes("facility") ||
    s.includes("picked up") ||
    s.includes("dispatched") ||
    s.includes("at local facility")
  ) {
    return "In Transit";
  }

  if (
    s.includes("exception") ||
    s.includes("failed")
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