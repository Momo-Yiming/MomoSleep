CREATE TABLE IF NOT EXISTS cash_redemptions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    points INTEGER NOT NULL CHECK (points > 0),
    rate_fen_per_100_points INTEGER NOT NULL CHECK (rate_fen_per_100_points > 0),
    amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
    quote_version TEXT NOT NULL,
    payout_channel TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cash_redemptions_account
ON cash_redemptions(account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_redemptions_pending_account
ON cash_redemptions(account_id)
WHERE status = 'integration_pending';
