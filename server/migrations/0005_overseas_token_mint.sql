CREATE TABLE IF NOT EXISTS token_mints (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL REFERENCES claims(id),
    claim_commitment TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL UNIQUE,
    points INTEGER NOT NULL CHECK (points > 0 AND points <= 1000),
    token_amount_wei TEXT NOT NULL,
    status TEXT NOT NULL,
    transaction_hash TEXT UNIQUE,
    contract_address TEXT NOT NULL,
    block_number INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    UNIQUE(account_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_token_mints_account
ON token_mints(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_mints_public
ON token_mints(status, confirmed_at DESC);
