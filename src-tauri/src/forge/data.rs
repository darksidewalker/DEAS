//! Built-in, pinned Forge data; existing environment files override it without writes.
use rusqlite::{Connection, OpenFlags};
use std::{io, path::Path};

fn bundled(name: &str) -> Option<&'static [u8]> {
    match name {
        "forge-pack.json" => Some(include_bytes!("../../forge-data/forge-pack.json")),
        "randomizer.json" => Some(include_bytes!("../../forge-data/randomizer.json")),
        "tags.sqlite" => Some(include_bytes!("../../forge-data/tags.sqlite")),
        "character_traits.sqlite" => {
            Some(include_bytes!("../../forge-data/character_traits.sqlite"))
        }
        _ => None,
    }
}

pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    match std::fs::read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(bundled)
            .map(<[u8]>::to_vec)
            .ok_or(e),
        result => result,
    }
}

pub fn database(path: &Path) -> Result<Connection, String> {
    // Only a missing file selects the bundle; malformed/unreadable overrides remain errors.
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let bytes = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(bundled)
                .ok_or_else(|| e.to_string())?;
            let mut db = Connection::open_in_memory().map_err(|e| e.to_string())?;
            db.deserialize_read_exact(rusqlite::MAIN_DB, bytes, bytes.len(), true)
                .map_err(|e| e.to_string())?;
            Ok(db)
        }
        Err(e) => Err(e.to_string()),
        Ok(_) => Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string()),
    }
}
