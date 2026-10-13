-- Virtual SLEEP is a zero-value sandbox balance, separate from token_mints.
CREATE TABLE sandbox_token_exchanges (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    points INTEGER NOT NULL CHECK (points >= 1 AND points <= 10000),
    token_amount INTEGER NOT NULL CHECK (token_amount = points),
    status TEXT NOT NULL CHECK (status = 'sandbox_completed'),
    created_at TEXT NOT NULL
);

CREATE INDEX idx_sandbox_token_exchanges_account
ON sandbox_token_exchanges(account_id, created_at DESC);
