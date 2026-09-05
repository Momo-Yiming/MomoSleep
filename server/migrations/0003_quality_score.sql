ALTER TABLE claims ADD COLUMN scoring_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE claims ADD COLUMN score_breakdown_json TEXT;

CREATE INDEX IF NOT EXISTS idx_claims_batch_version
ON claims(batch_id, status, scoring_version);
