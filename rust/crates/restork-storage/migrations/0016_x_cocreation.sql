CREATE TABLE x_cocreation_drafts (
    draft_id TEXT PRIMARY KEY,
    artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
    artifact_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'discarded')),
    final_body TEXT,
    final_reply TEXT,
    final_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX x_cocreation_drafts_updated
    ON x_cocreation_drafts (updated_at DESC, draft_id DESC);

CREATE TABLE x_cocreation_edits (
    edit_id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    original_body TEXT NOT NULL,
    final_body TEXT NOT NULL,
    final_reply TEXT NOT NULL,
    final_url TEXT,
    difference_kinds_json TEXT NOT NULL CHECK (json_valid(difference_kinds_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (draft_id) REFERENCES x_cocreation_drafts(draft_id)
);

CREATE INDEX x_cocreation_edits_created
    ON x_cocreation_edits (created_at DESC, edit_id DESC);
