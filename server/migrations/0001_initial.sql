PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '睡眠体验用户',
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    night_key TEXT NOT NULL,
    commitment TEXT NOT NULL UNIQUE,
    asleep_minutes INTEGER NOT NULL,
    core_minutes INTEGER NOT NULL,
    rem_minutes INTEGER NOT NULL,
    deep_minutes INTEGER NOT NULL,
    raw_points INTEGER NOT NULL,
    awarded_points INTEGER NOT NULL,
    trust_grade TEXT NOT NULL,
    status TEXT NOT NULL,
    batch_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(account_id, night_key)
);

CREATE TABLE IF NOT EXISTS point_entries (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    points INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reference_id TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    price_points INTEGER NOT NULL CHECK (price_points > 0),
    stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    price_points INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anchor_batches (
    id TEXT PRIMARY KEY,
    merkle_root TEXT NOT NULL UNIQUE,
    scoring_version INTEGER NOT NULL,
    claim_count INTEGER NOT NULL,
    chain_status TEXT NOT NULL,
    transaction_hash TEXT,
    contract_address TEXT,
    created_at TEXT NOT NULL,
    anchored_at TEXT
);

INSERT OR IGNORE INTO products (id, title, price_points, stock) VALUES
    ('sleep-mask', '遮光睡眠眼罩', 180, 999),
    ('white-noise', '白噪音七天权益', 260, 999),
    ('pillow-coupon', '睡眠枕商城优惠券', 420, 999);

CREATE INDEX IF NOT EXISTS idx_claims_account ON claims(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_batch ON claims(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_account ON point_entries(account_id, created_at DESC);
