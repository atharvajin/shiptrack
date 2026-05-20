function getHeader(req, name) {
  const headers = req.headers || {};
  const value = headers[name] || headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value || "";
}

function getRequestApiKey(req) {
  const directKey = getHeader(req, "x-api-key");

  if (directKey) {
    return String(directKey).trim();
  }

  const authorization = getHeader(req, "authorization");

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function requireApiKey(req, res) {
  const expectedKey = process.env.SHIPTRACK_API_KEY;

  if (!expectedKey) {
    console.warn(
      "[ShipTrack] SHIPTRACK_API_KEY is not set. API key check skipped."
    );
    return true;
  }

  const requestKey = getRequestApiKey(req);

  if (!requestKey || requestKey !== expectedKey) {
    res.status(401).json({
      error: "Unauthorized. Missing or invalid ShipTrack API key.",
    });
    return false;
  }

  return true;
}

function shouldProtectReads() {
  return String(process.env.SHIPTRACK_PROTECT_READS || "").toLowerCase() === "true";
}

module.exports = {
  requireApiKey,
  shouldProtectReads,
};