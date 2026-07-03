require("dotenv").config({ path: ".env.local" });
// Local dev — never require API key
process.env.SHIPTRACK_API_KEY = "";
const http = require("http");
const url = require("url");

const routes = [
  { match: /^\/api\/orders\/refresh-tracking(\?|$)/, handler: "./api/orders/refresh-tracking" },
  { match: /^\/api\/orders\/([^/]+)$/, handler: "./api/orders/[order_id]" },
  { match: /^\/api\/orders(\?|$)/, handler: "./api/orders/index" },
  { match: /^\/api\/add-tracking(\?|$)/, handler: "./api/add-tracking" },
];

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch {
        req.body = {};
      }
      resolve();
    });
  });
}

function wrapRes(res) {
  res.status = function (code) {
    res.statusCode = code;
    return this;
  };
  res.json = function (data) {
    const body = JSON.stringify(data);
    if (!res.headersSent) {
      res.writeHead(res.statusCode || 200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization",
      });
    }
    res.end(body);
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  req.query = parsed.query;
  req.path = parsed.pathname;
  wrapRes(res);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.status(200).json({ ok: true });
    return;
  }

  // Request timeout — fail fast instead of hanging on Supabase
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: "Gateway timeout", details: "Backend request timed out" });
    }
  }, 30000);

  for (const route of routes) {
    const match = req.path.match(route.match);
    if (match) {
      if (match[1]) req.params = { order_id: match[1] };
      await parseBody(req);
      try {
        const handler = require(route.handler);
        await handler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error", details: err.message });
        }
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
  }

  clearTimeout(timeout);
  res.status(404).json({ error: "Not found", path: req.path });
});

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`ShipTrack API running on http://localhost:${PORT}`);
});
