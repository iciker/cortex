use crate::error::Result;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

/// Embedded migrations. Index in the array == target `user_version`.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_preview_and_memory.sql"),
    include_str!("../migrations/0003_subject_color.sql"),
    include_str!("../migrations/0004_topic_glyph.sql"),
    include_str!("../migrations/0005_notes.sql"),
    include_str!("../migrations/0006_events.sql"),
    include_str!("../migrations/0007_review.sql"),
    include_str!("../migrations/0008_srs.sql"),
    include_str!("../migrations/0009_citations.sql"),
    include_str!("../migrations/0010_cheatsheet_image.sql"),
    include_str!("../migrations/0011_tags.sql"),
    include_str!("../migrations/0012_cheatsheet_versions.sql"),
    include_str!("../migrations/0013_custom_stations.sql"),
    include_str!("../migrations/0014_event_reminder_index.sql"),
    include_str!("../migrations/0015_event_priority_topics.sql"),
    include_str!("../migrations/0016_fsrs.sql"),
    include_str!("../migrations/0017_pomodoro_sessions.sql"),
    include_str!("../migrations/0018_exams.sql"),
    include_str!("../migrations/0019_tombstones.sql"),
    include_str!("../migrations/0020_moodle.sql"),
    include_str!("../migrations/0021_subject_framework.sql"),
    include_str!("../migrations/0022_framework_file.sql"),
    include_str!("../migrations/0023_announcement_url.sql"),
    include_str!("../migrations/0024_subject_aliases.sql"),
    include_str!("../migrations/0025_subject_archived.sql"),
    include_str!("../migrations/0026_event_status.sql"),
    include_str!("../migrations/0027_google_event_tombstone.sql"),
    include_str!("../migrations/0028_cheatsheet_tombstone.sql"),
    include_str!("../migrations/0029_source_diarize.sql"),
    include_str!("../migrations/0030_sync_content_timestamps.sql"),
];

/// Shared application state: a single SQLite connection behind a Mutex.
/// rusqlite is synchronous; Tauri runs commands on a worker pool so brief
/// lock contention is acceptable for a single-user desktop app.
pub struct AppState {
    pub db: Mutex<Connection>,
}

/// Register the statically-linked `sqlite-vec` extension as an auto-extension so
/// every connection opened afterward gets the `vec_distance_cosine` SQL function
/// (used by `repo::search_chunks`). No runtime `.so` is loaded — the extension is
/// compiled in and registered via SQLite's auto-extension hook. Idempotent.
fn register_sqlite_vec() {
    use std::sync::Once;
    static VEC_INIT: Once = Once::new();
    VEC_INIT.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *mut std::ffi::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::ffi::c_int,
        >(
            sqlite_vec::sqlite3_vec_init as *const ()
        )));
    });
}

impl AppState {
    pub fn new(db_path: &PathBuf) -> Result<Self> {
        register_sqlite_vec();
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        run_migrations(&conn)?;
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// In-memory database, for tests.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        register_sqlite_vec();
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        run_migrations(&conn)?;
        Ok(Self {
            db: Mutex::new(conn),
        })
    }
}

/// Apply any migrations whose index is beyond the current `user_version`.
fn run_migrations(conn: &Connection) -> Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    while (version as usize) < MIGRATIONS.len() {
        let sql = MIGRATIONS[version as usize];
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        version += 1;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_vec_extension_is_registered() {
        // Proves the statically-linked sqlite-vec auto-extension is actually live
        // (so search_chunks uses it, not the Rust fallback). Identical vectors have
        // cosine distance 0; orthogonal vectors distance 1.
        let st = AppState::in_memory().unwrap();
        let conn = st.db.lock().unwrap();
        let a = crate::vector::f32s_to_blob(&[1.0, 0.0, 0.0]);
        let b = crate::vector::f32s_to_blob(&[0.0, 1.0, 0.0]);
        let same: f64 = conn
            .query_row("SELECT vec_distance_cosine(?1, ?1)", [&a], |r| r.get(0))
            .expect("vec_distance_cosine must be registered");
        let orth: f64 = conn
            .query_row("SELECT vec_distance_cosine(?1, ?2)", [&a, &b], |r| r.get(0))
            .unwrap();
        assert!(
            same.abs() < 1e-5,
            "identical vectors distance ~0, got {same}"
        );
        assert!(
            (orth - 1.0).abs() < 1e-5,
            "orthogonal vectors distance ~1, got {orth}"
        );
    }

    #[test]
    fn migrations_apply_and_are_idempotent() {
        let st = AppState::in_memory().unwrap();
        let conn = st.db.lock().unwrap();
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        // tables exist
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='subjects'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }
}

#[cfg(test)]
mod sync_migration_regressions {
    use super::*;

    #[test]
    fn upgrade_preserves_legacy_content_and_failed_migration_is_retryable() {
        let c = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..29] {
            c.execute_batch(sql).unwrap();
        }
        c.pragma_update(None, "user_version", 29).unwrap();
        c.execute_batch("INSERT INTO subjects(id,name,created_at,updated_at) VALUES('s','Course',1,2);
            INSERT INTO materials(id,subject_id,kind,title,created_at) VALUES('m','s','quiz','Kept',3);
            INSERT INTO cheatsheets(id,subject_id,created_at,updated_at) VALUES('c','s',4,5);
            INSERT INTO cheatsheet_sections(id,cheatsheet_id,title,body) VALUES('sec','c','Kept section','[]');
            INSERT INTO settings(key,value) VALUES('livesync_pushed_at','999');
            CREATE TRIGGER reject_reset BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(run_migrations(&c).is_err());
        let version: i64 = c
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 29);
        assert!(c.prepare("SELECT updated_at FROM materials").is_err());
        c.execute_batch("DROP TRIGGER reject_reset").unwrap();
        run_migrations(&c).unwrap();
        run_migrations(&c).unwrap();
        let material: (String, i64) = c
            .query_row("SELECT title,updated_at FROM materials", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(material, ("Kept".into(), 3));
        let section: (String, i64) = c
            .query_row(
                "SELECT title,updated_at FROM cheatsheet_sections",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(section, ("Kept section".into(), 5));
        assert!(crate::repo::get_setting(&c, "livesync_pushed_at")
            .unwrap()
            .is_none());
    }
}
