-- ─── Run this entire file in your Supabase SQL Editor ───────────────────────
-- Go to: supabase.com → your project → SQL Editor → New query → paste → Run

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  order_id      TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  items         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Shipments table (one per order)
CREATE TABLE IF NOT EXISTS shipments (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  tracking_id        TEXT NOT NULL,
  courier            TEXT,
  tracking_link      TEXT NOT NULL,
  last_status        TEXT DEFAULT 'Pending',
  current_location   TEXT,
  estimated_delivery TEXT,
  last_updated       TIMESTAMPTZ DEFAULT NOW(),
  raw_history        JSONB DEFAULT '[]'
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_shipments_order_id    ON shipments(order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking_id ON shipments(tracking_id);
CREATE INDEX IF NOT EXISTS idx_shipments_status       ON shipments(last_status);

-- Seed sample orders (feel free to change these)
INSERT INTO orders (order_id, customer_name, items) VALUES
  ('ORD-1001', 'Priya Sharma',  'Blue Kurta Set, Ethnic Earrings'),
  ('ORD-1002', 'Rahul Mehta',   'Running Shoes (Size 9), Sports Socks'),
  ('ORD-1003', 'Anjali Gupta',  'Laptop Stand, USB-C Hub'),
  ('ORD-1004', 'Vikram Singh',  'Cotton Bedsheet Set, Pillow Covers'),
  ('ORD-1005', 'Sneha Patel',   'Face Serum, Vitamin C Cream')
ON CONFLICT (order_id) DO NOTHING;

-- ─── Row Level Security (optional but recommended) ────────────────────────────
-- If you want to lock down the DB so only your backend can access it:
-- ALTER TABLE orders    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
-- Then use SUPABASE_SERVICE_KEY (not anon key) in your backend — it bypasses RLS.
