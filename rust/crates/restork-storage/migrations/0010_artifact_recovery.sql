CREATE TABLE checkpoint_file_blobs (
    checkpoint_id TEXT NOT NULL REFERENCES recovery_checkpoints(checkpoint_id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    content BLOB NOT NULL,
    PRIMARY KEY (checkpoint_id, relative_path)
);

ALTER TABLE deliverable_exports ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX deliverable_export_idempotency
    ON deliverable_exports (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX deliverable_export_history
    ON deliverable_exports (deliverable_id, revision DESC, created_at DESC);
