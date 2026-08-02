CREATE TABLE deliverables (
    deliverable_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily_report', 'weekly_report', 'deck')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
    artifact_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (deliverable_id, revision)
);

CREATE INDEX deliverables_page ON deliverables (updated_at DESC, deliverable_id DESC);

CREATE TABLE deliverable_exports (
    export_id TEXT PRIMARY KEY,
    deliverable_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('markdown', 'pptx', 'pdf')),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    output_hash TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (deliverable_id, revision) REFERENCES deliverables(deliverable_id, revision)
);

CREATE INDEX deliverable_exports_page ON deliverable_exports (created_at DESC, export_id DESC);

CREATE TABLE deliverable_templates (
    template_id TEXT PRIMARY KEY,
    template_json TEXT NOT NULL CHECK (json_valid(template_json)),
    template_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
