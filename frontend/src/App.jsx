import { useState, useEffect, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });

  const text = await res.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = {
        error: `Server returned non-JSON response. Status: ${res.status}`,
        details: text.slice(0, 500),
      };
    }
  }

  if (!res.ok) {
    throw data.error ? data : { error: `Request failed with status ${res.status}` };
  }

  return data;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  "In Transit": { bg: "#E6F1FB", text: "#185FA5", border: "#185FA5" },
  "Out for Delivery": { bg: "#FAEEDA", text: "#854F0B", border: "#BA7517" },
  "Delivered": { bg: "#EAF3DE", text: "#3B6D11", border: "#3B6D11" },
  "Exception": { bg: "#FCEBEB", text: "#A32D2D", border: "#A32D2D" },
  "Pending": { bg: "#F1EFE8", text: "#5F5E5A", border: "#888780" },
};

const COURIER_COLORS = {
  Delhivery: "#E03C2C", BlueDart: "#E31837", DTDC: "#E8A000",
  FedEx: "#4D148C", DHL: "#CC0000", UPS: "#351C15",
  "India Post": "#E83E0A", "Ecom Express": "#1A9E2E",
  Xpressbees: "#FF6B00", Shadowfax: "#0055FF", Shiprocket: "#7C3AED",
};

const SCRAPE_STEPS = ["Parsing URL", "Opening page", "Waiting for JS", "Extracting data", "Saving"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return iso; }
}

function timeAgo(iso) {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (d < 1) return "just now";
  if (d < 60) return `${d}m ago`;
  if (d < 1440) return `${Math.floor(d / 60)}h ago`;
  return `${Math.floor(d / 1440)}d ago`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cfg = STATUS_COLORS[status] || STATUS_COLORS["Pending"];
  const pulse = ["In Transit", "Out for Delivery"].includes(status);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 11, fontWeight: 500, padding: "3px 9px",
      borderRadius: 20, background: cfg.bg, color: cfg.text,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: "50%", background: cfg.text, flexShrink: 0,
        animation: pulse ? "pulse 1.4s infinite" : "none",
      }} />
      {status}
    </span>
  );
}

function CourierChip({ courier }) {
  const color = COURIER_COLORS[courier] || "#185FA5";
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, padding: "3px 10px",
      borderRadius: 20, background: color, color: "#fff",
    }}>
      {courier}
    </span>
  );
}

function Timeline({ history }) {
  if (!history?.length) return <p style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>No history yet.</p>;
  return (
    <div>
      {[...history].reverse().map((ev, i) => (
        <div key={i} style={{ display: "flex", gap: 10, paddingBottom: i < history.length - 1 ? 10 : 0 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginTop: 3,
              background: i === 0 ? "#185FA5" : "var(--color-border-secondary)",
            }} />
            {i < history.length - 1 && (
              <div style={{ width: 1, flex: 1, background: "var(--color-border-tertiary)", marginTop: 4, minHeight: 16 }} />
            )}
          </div>
          <div style={{ paddingBottom: 2 }}>
            <p style={{ fontSize: 12, color: i === 0 ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
              {ev.message}
            </p>
            <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>
              {[ev.location, ev.timestamp ? formatDate(ev.timestamp) : null].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function TrackingCard({ shipment, orderId, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const cfg = STATUS_COLORS[shipment.status] || STATUS_COLORS["Pending"];

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiFetch(`/orders/${orderId}/refresh-tracking`, { method: "POST" });
      onRefresh?.();
    } catch (e) { console.error(e); }
    finally { setRefreshing(false); }
  };

  return (
    <div style={{
      borderTop: "0.5px solid var(--color-border-tertiary)",
      padding: "12px 16px",
    }}>
      {/* Top row */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 16, marginBottom: 10 }}>
        <div>
          <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 2 }}>Status</p>
          <StatusBadge status={shipment.status} />
        </div>
        {shipment.courier && (
          <div>
            <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 2 }}>Courier</p>
            <CourierChip courier={shipment.courier} />
          </div>
        )}
        <div>
          <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 2 }}>Tracking ID</p>
          <code style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--color-text-primary)" }}>
            {shipment.tracking_id}
          </code>
        </div>
        {shipment.current_location && (
          <div>
            <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 2 }}>Location</p>
            <p style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
              {shipment.current_location}
            </p>
          </div>
        )}
        {shipment.estimated_delivery && (
          <div>
            <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 2 }}>Est. delivery</p>
            <p style={{ fontSize: 13, fontWeight: 500, color: cfg.text }}>
              {formatDate(shipment.estimated_delivery)}
            </p>
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {shipment.tracking_link && (
            <a href={shipment.tracking_link} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: "var(--color-text-secondary)", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>
              ↗ View
            </a>
          )}
          <button onClick={handleRefresh} disabled={refreshing}
            style={{ fontSize: 12, color: "var(--color-text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {refreshing ? "⟳ Refreshing..." : `Updated ${timeAgo(shipment.last_updated)}`}
          </button>
        </div>
      </div>

      {/* History toggle */}
      {shipment.history?.length > 0 && (
        <>
          <button onClick={() => setOpen(!open)}
            style={{ fontSize: 12, color: "var(--color-text-secondary)", background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
            ⏱ View history ({shipment.history.length} events)
            <span style={{ display: "inline-block", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "none" }}>▾</span>
          </button>
          {open && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
              <Timeline history={shipment.history} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OrderCard({ order, onUpdate }) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div style={{
      background: "var(--color-background-primary)",
      border: `0.5px solid var(--color-border-tertiary)`,
      borderLeft: order.shipment
        ? `3px solid ${STATUS_COLORS[order.shipment.status]?.border || "#185FA5"}`
        : "0.5px solid var(--color-border-tertiary)",
      borderRadius: "var(--border-radius-lg)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "14px 16px 10px" }}>
        <div style={{ minWidth: 0 }}>
          <code style={{
            fontSize: 11, fontWeight: 500, fontFamily: "var(--font-mono)",
            background: "var(--color-background-secondary)", color: "var(--color-text-secondary)",
            padding: "2px 8px", borderRadius: 4, display: "inline-block", marginBottom: 4,
          }}>
            {order.order_id}
          </code>
          <p style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)" }}>{order.customer_name}</p>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
            {order.items}
          </p>
        </div>
        {order.shipment && <StatusBadge status={order.shipment.status} />}
      </div>

      {/* Tracking / Add form */}
      {order.shipment ? (
        <TrackingCard shipment={order.shipment} orderId={order.order_id} onRefresh={onUpdate} />
      ) : (
        <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", padding: "12px 16px" }}>
          {showForm ? (
            <AddTrackingForm orderId={order.order_id} onSuccess={onUpdate} onCancel={() => setShowForm(false)} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>No tracking added</span>
              <button onClick={() => setShowForm(true)}
                style={{
                  fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer",
                  border: "0.5px dashed var(--color-border-secondary)", background: "transparent",
                  padding: "4px 12px", borderRadius: "var(--border-radius-md)",
                }}>
                + Add tracking URL
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Scraping progress indicator ─────────────────────────────────────────────
function ScrapingProgress({ step }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{
          width: 16, height: 16, border: "2px solid var(--color-border-tertiary)",
          borderTopColor: "#185FA5", borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }} />
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {SCRAPE_STEPS[step]}...
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {SCRAPE_STEPS.map((s, i) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: i < step ? "#1D9E75" : i === step ? "#185FA5" : "var(--color-border-tertiary)",
                animation: i === step ? "pulse 1s infinite" : "none",
              }} />
              <span style={{ fontSize: 9, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>{s}</span>
            </div>
            {i < SCRAPE_STEPS.length - 1 && (
              <div style={{ width: 20, height: 1, background: i < step ? "#1D9E75" : "var(--color-border-tertiary)", marginBottom: 12 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AddTrackingForm({ orderId, onSuccess, onCancel }) {
  const [url, setUrl] = useState("");
  const [step, setStep] = useState(-1);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);

    try { new URL(url.trim()); }
    catch (_) {
      setError("Invalid URL — paste the full https:// link from the courier website");
      return;
    }

    // Simulate scraping steps in UI while real scraping happens
    const simulateSteps = async () => {
      for (let i = 0; i < SCRAPE_STEPS.length - 1; i++) {
        setStep(i);
        await sleep(i === 1 ? 900 : i === 2 ? 1200 : 500);
      }
    };

    try {
      setStep(0);
      const [data] = await Promise.all([
        apiFetch("/add-tracking", {
          method: "POST",
          body: JSON.stringify({
            order_id: orderId,
            tracking_link: url.trim(),
          }),
        }),
        simulateSteps(),
      ]);
      setStep(SCRAPE_STEPS.length - 1);
      await sleep(400);
      onSuccess?.();
    } catch (err) {
      setStep(-1);
      setError(err.error || err.message || "Failed to add tracking — try again");
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text" value={url} onChange={e => setUrl(e.target.value)}
          placeholder="https://www.delhivery.com/track/package?wbn=DEL123..."
          style={{ flex: 1 }} disabled={step >= 0} autoFocus
        />
        <button type="submit" disabled={step >= 0 || !url.trim()}>
          {step >= 0 ? "Scraping..." : "Extract & track"}
        </button>
        <button type="button" onClick={onCancel} disabled={step >= 0}>Cancel</button>
      </div>

      {step >= 0 && <ScrapingProgress step={step} />}

      {error && (
        <div style={{
          marginTop: 8, fontSize: 12, color: "#A32D2D",
          background: "#FCEBEB", padding: "8px 12px",
          borderRadius: "var(--border-radius-md)", display: "flex", gap: 6,
        }}>
          ⚠ {error}
        </div>
      )}
    </form>
  );
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
function StatsBar({ orders }) {
  const s = {
    total: orders.length,
    tracked: orders.filter(o => o.shipment).length,
    transit: orders.filter(o => o.shipment?.status === "In Transit").length,
    ofd: orders.filter(o => o.shipment?.status === "Out for Delivery").length,
    delivered: orders.filter(o => o.shipment?.status === "Delivered").length,
  };
  const items = [
    { label: "Total orders", value: s.total, color: "var(--color-text-primary)" },
    { label: "Tracked", value: s.tracked, color: "#185FA5" },
    { label: "In transit", value: s.transit, color: "#BA7517" },
    { label: "Out for delivery", value: s.ofd, color: "#E8A000" },
    { label: "Delivered", value: s.delivered, color: "#3B6D11" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 24 }}>
      {items.map(item => (
        <div key={item.label} style={{
          background: "var(--color-background-secondary)",
          borderRadius: "var(--border-radius-md)",
          padding: "12px 16px",
        }}>
          <p style={{ fontSize: 22, fontWeight: 500, color: item.color }}>{item.value}</p>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>{item.label}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await apiFetch("/orders");
      setOrders(data.orders || []);
      setBackendOnline(true);
    } catch (_) {
      setBackendOnline(false);
      setOrders(DEMO_ORDERS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = orders.filter(o => {
    const fm = filter === "all" ||
      (filter === "untracked" && !o.shipment) ||
      (filter === "transit" && o.shipment?.status === "In Transit") ||
      (filter === "ofd" && o.shipment?.status === "Out for Delivery") ||
      (filter === "delivered" && o.shipment?.status === "Delivered");
    const sm = !search ||
      o.order_id?.toLowerCase().includes(search.toLowerCase()) ||
      o.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
      o.shipment?.tracking_id?.toLowerCase().includes(search.toLowerCase());
    return fm && sm;
  });

  const FILTERS = [
    { key: "all", label: "All" },
    { key: "untracked", label: "No tracking" },
    { key: "transit", label: "In transit" },
    { key: "ofd", label: "Out for delivery" },
    { key: "delivered", label: "Delivered" },
  ];

  return (
    <>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.4)} }
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        body { margin: 0; background: var(--color-background-tertiary); }
      `}</style>

      <nav style={{
        background: "var(--color-background-primary)",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        position: "sticky", top: 0, zIndex: 20, padding: "0 24px",
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 8, background: "#185FA5",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, color: "#fff", fontWeight: 500,
            }}>ST</div>
            <div>
              <p style={{ fontWeight: 500, fontSize: 14, color: "var(--color-text-primary)", lineHeight: 1 }}>ShipTrack</p>
              <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1, marginTop: 2 }}>Order shipment management</p>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {!backendOnline && (
              <span style={{ fontSize: 11, color: "#854F0B", background: "#FAEEDA", padding: "3px 8px", borderRadius: 4 }}>
                Demo mode
              </span>
            )}
            <button onClick={load} style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              ⟳ Refresh
            </button>
          </div>
        </div>
      </nav>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px 24px" }}>
        {!backendOnline && (
          <div style={{
            marginBottom: 16, padding: "10px 14px",
            background: "#FAEEDA", borderRadius: "var(--border-radius-md)",
            fontSize: 12, color: "#854F0B", display: "flex", gap: 8,
          }}>
            ⚠ Backend not running — showing demo data. Start the server with <code>npm run dev</code> in the backend folder.
          </div>
        )}

        <StatsBar orders={orders} />

        {/* Search + filter */}
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search order ID, customer, or tracking number..."
            style={{ flex: 1, minWidth: 200 }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                style={{
                  fontSize: 12, padding: "4px 12px",
                  background: filter === f.key ? "#185FA5" : "var(--color-background-primary)",
                  color: filter === f.key ? "#fff" : "var(--color-text-secondary)",
                  border: filter === f.key ? "none" : "0.5px solid var(--color-border-secondary)",
                  borderRadius: "var(--border-radius-md)", cursor: "pointer",
                }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Orders */}
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[...Array(3)].map((_, i) => (
              <div key={i} style={{
                height: 100, background: "var(--color-background-primary)",
                borderRadius: "var(--border-radius-lg)",
                border: "0.5px solid var(--color-border-tertiary)",
                animation: "pulse 1.5s infinite",
              }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem 0", color: "var(--color-text-secondary)", fontSize: 13 }}>
            <p style={{ fontSize: 32, marginBottom: 8 }}>📦</p>
            <p>No orders match your filter</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map(order => (
              <OrderCard key={order.order_id} order={order} onUpdate={load} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

// ─── Demo data (shown when backend offline) ───────────────────────────────────
const DEMO_ORDERS = [
  {
    order_id: "ORD-1001", customer_name: "Priya Sharma", items: "Blue Kurta Set, Ethnic Earrings",
    created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
    shipment: {
      tracking_id: "DEL2024001234", courier: "Delhivery", tracking_link: "#",
      status: "In Transit", current_location: "Mumbai Sorting Center",
      estimated_delivery: new Date(Date.now() + 86400000 * 2).toISOString().split("T")[0],
      last_updated: new Date(Date.now() - 3600000).toISOString(),
      history: [
        { timestamp: new Date(Date.now() - 3600000).toISOString(), status: "InTransit", message: "In transit to destination hub", location: "Mumbai Sorting Center" },
        { timestamp: new Date(Date.now() - 86400000).toISOString(), status: "InTransit", message: "Departed Hyderabad Hub", location: "Hyderabad, Telangana" },
        { timestamp: new Date(Date.now() - 86400000 * 2).toISOString(), status: "InTransit", message: "Package picked up by courier", location: "Bangalore, Karnataka" },
      ],
    },
  },
  {
    order_id: "ORD-1002", customer_name: "Rahul Mehta", items: "Running Shoes (Size 9), Sports Socks",
    created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
    shipment: {
      tracking_id: "BD1234567890", courier: "BlueDart", tracking_link: "#",
      status: "Out for Delivery", current_location: "Pune Delivery Zone",
      estimated_delivery: new Date().toISOString().split("T")[0],
      last_updated: new Date(Date.now() - 7200000).toISOString(),
      history: [
        { timestamp: new Date(Date.now() - 7200000).toISOString(), status: "OutForDelivery", message: "Out for delivery with courier agent", location: "Pune Delivery Zone" },
        { timestamp: new Date(Date.now() - 86400000).toISOString(), status: "InTransit", message: "Reached destination city hub", location: "Pune City Hub" },
      ],
    },
  },
  {
    order_id: "ORD-1003", customer_name: "Anjali Gupta", items: "Laptop Stand, USB-C Hub",
    created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    shipment: {
      tracking_id: "DTDC987654321", courier: "DTDC", tracking_link: "#",
      status: "Delivered", current_location: "Coimbatore, Tamil Nadu",
      estimated_delivery: null, last_updated: new Date(Date.now() - 86400000).toISOString(),
      history: [
        { timestamp: new Date(Date.now() - 86400000).toISOString(), status: "Delivered", message: "Package delivered successfully", location: "Coimbatore, Tamil Nadu" },
        { timestamp: new Date(Date.now() - 86400000 * 2).toISOString(), status: "OutForDelivery", message: "Out for delivery", location: "Coimbatore" },
      ],
    },
  },
  { order_id: "ORD-1004", customer_name: "Vikram Singh", items: "Cotton Bedsheet Set, Pillow Covers", created_at: new Date(Date.now() - 86400000).toISOString(), shipment: null },
  { order_id: "ORD-1005", customer_name: "Sneha Patel", items: "Face Serum, Vitamin C Cream", created_at: new Date(Date.now() - 86400000 * 2).toISOString(), shipment: null },
];
