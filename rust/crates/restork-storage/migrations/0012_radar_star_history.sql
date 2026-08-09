ALTER TABLE radar_items ADD COLUMN stars_total INTEGER CHECK (stars_total >= 0);
ALTER TABLE radar_items ADD COLUMN stars_daily INTEGER;
ALTER TABLE radar_items ADD COLUMN stars_weekly INTEGER;

CREATE TABLE radar_star_snapshots (
    item_id TEXT NOT NULL,
    observed_on TEXT NOT NULL,
    stars_total INTEGER NOT NULL CHECK (stars_total >= 0),
    observed_at TEXT NOT NULL,
    PRIMARY KEY (item_id, observed_on)
);

CREATE INDEX radar_star_snapshots_history
    ON radar_star_snapshots (item_id, observed_on DESC);
