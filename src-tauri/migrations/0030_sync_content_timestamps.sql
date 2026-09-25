-- Mutable content must participate in newest-wins merging and delta export.
ALTER TABLE materials ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE materials SET updated_at = created_at;

ALTER TABLE cheatsheet_sections ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE cheatsheet_sections SET updated_at = COALESCE(
  (SELECT updated_at FROM cheatsheets WHERE id = cheatsheet_sections.cheatsheet_id), 0
);

CREATE TRIGGER tomb_cheatsheet_sections AFTER DELETE ON cheatsheet_sections BEGIN
  INSERT OR REPLACE INTO tombstones VALUES (
    'cheatsheet_sections', OLD.id,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  );
END;

-- Send previously omitted sections once, even if their parent is unchanged.
DELETE FROM settings WHERE key = 'livesync_pushed_at';
