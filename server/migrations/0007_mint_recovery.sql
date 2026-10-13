ALTER TABLE token_mints ADD COLUMN updated_at TEXT;
ALTER TABLE token_mints ADD COLUMN attempt_id TEXT;
UPDATE token_mints SET updated_at = COALESCE(confirmed_at, created_at);

-- Older failed rows may already have been broadcast. Do not free their nonce,
-- recipient or quota merely because the old receipt wait failed.
UPDATE token_mints SET status = 'submitted'
WHERE status = 'failed' AND transaction_hash IS NOT NULL;
UPDATE token_mints SET status = 'needs_review',
  error_message = '旧版本未保存交易哈希，需核对链上状态后恢复。'
WHERE status IN ('failed', 'preparing') AND transaction_hash IS NULL;

CREATE TABLE chain_transactions (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE,
  signed_transaction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chain_id, sender, nonce)
);
CREATE UNIQUE INDEX idx_chain_transactions_operation
ON chain_transactions(operation_key) WHERE status != 'reverted';
CREATE TABLE chain_submission_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
