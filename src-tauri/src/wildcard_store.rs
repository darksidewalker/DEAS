//! App-local wildcard snapshots. Each choice is indexed so preview and selection read only what they need.
use crate::wildcard_packs::{self, ChoiceCatalog, ExpandedPrompts, WildcardPack};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

const FILE: &str = "studio-wildcards.sqlite3";
const MAX_PACKS: usize = 16;
const PAGE_LIMIT: i64 = 100;

#[derive(Debug, Serialize)]
pub struct PackSummary {
    id: String,
    name: String,
    lists: BTreeMap<String, u32>,
}

pub(crate) struct Store(Connection);

fn database_error(_: rusqlite::Error) -> String {
    "Could not read or update the local wildcard store".into()
}

impl Store {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|_| "Cannot open the Studio preferences folder")?;
        let path = root.join(FILE);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err("Expected a regular Studio wildcard store".into()),
        }
        let db = Connection::open(path).map_err(database_error)?;
        db.busy_timeout(Duration::from_secs(4))
            .map_err(database_error)?;
        db.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS packs (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0)
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS lists (
               name TEXT PRIMARY KEY, pack TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
               choices INTEGER NOT NULL CHECK(choices > 0)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS lists_by_pack ON lists(pack);
             CREATE TABLE IF NOT EXISTS choices (
               name TEXT NOT NULL REFERENCES lists(name) ON DELETE CASCADE,
               position INTEGER NOT NULL CHECK(position >= 0), text TEXT NOT NULL, PRIMARY KEY(name, position)
             ) WITHOUT ROWID;",
        )
        .map_err(database_error)?;
        Ok(Self(db))
    }

    pub(crate) fn summaries(&self) -> Result<Vec<PackSummary>, String> {
        let mut query = self
            .0
            .prepare(
                "SELECT p.id, p.name, l.name, l.choices
             FROM packs p JOIN lists l ON l.pack = p.id ORDER BY p.name, p.id, l.name",
            )
            .map_err(database_error)?;
        let mut rows = query.query([]).map_err(database_error)?;
        let mut packs: Vec<PackSummary> = Vec::new();
        while let Some(row) = rows.next().map_err(database_error)? {
            let id: String = row.get(0).map_err(database_error)?;
            if packs.last().is_none_or(|pack| pack.id != id) {
                packs.push(PackSummary {
                    id,
                    name: row.get(1).map_err(database_error)?,
                    lists: BTreeMap::new(),
                });
            }
            packs.last_mut().expect("pack inserted above").lists.insert(
                row.get(2).map_err(database_error)?,
                row.get(3).map_err(database_error)?,
            );
        }
        Ok(packs)
    }

    pub(crate) fn import(&mut self, pack: WildcardPack) -> Result<(), String> {
        let tx = self
            .0
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        save(&tx, pack)?;
        tx.commit().map_err(database_error)
    }

    pub(crate) fn remove(&self, id: &str) -> Result<(), String> {
        self.0
            .execute("DELETE FROM packs WHERE id = ?1", [id])
            .map_err(database_error)?;
        Ok(())
    }

    pub(crate) fn page(&self, name: &str, offset: usize) -> Result<Vec<String>, String> {
        let offset = i64::try_from(offset).map_err(|_| "Invalid wildcard list offset")?;
        let mut query = self
            .0
            .prepare(
                "SELECT CASE WHEN length(text)>4096 THEN substr(text,1,4096)||'…' ELSE text END
             FROM choices WHERE name = ?1 AND position >= ?2 ORDER BY position LIMIT ?3",
            )
            .map_err(database_error)?;
        let rows = query
            .query_map(params![name, offset, PAGE_LIMIT], |row| row.get(0))
            .map_err(database_error)?;
        rows.collect::<Result<_, _>>().map_err(database_error)
    }

    pub(crate) fn expand(
        &mut self,
        positive: &str,
        negative: &str,
        seed: u32,
    ) -> Result<ExpandedPrompts, String> {
        let tx = self.0.transaction().map_err(database_error)?;
        wildcard_packs::expand_catalog(&tx, positive, negative, seed)
    }
}

fn save(tx: &Transaction<'_>, pack: WildcardPack) -> Result<(), String> {
    let WildcardPack { id, name, lists } = pack;
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || name.trim().is_empty()
        || name.len() > 1024
        || lists.is_empty()
    {
        return Err("Invalid wildcard pack identity".into());
    }
    let bytes = wildcard_packs::validate_catalog(&lists)?;
    // Deletion and reinsertion share one transaction so a rejected refresh preserves the current pack.
    tx.execute("DELETE FROM packs WHERE id = ?1", [&id])
        .map_err(database_error)?;
    // A pack is named after its folder, so choosing the same folder again (also after moving or copying it)
    // replaces the previous snapshot instead of failing on every list name it shares with itself.
    tx.execute("DELETE FROM packs WHERE name = ?1", [&name])
        .map_err(database_error)?;
    let (total_packs, total_bytes, total_lists): (u32, u32, u32) = tx
        .query_row(
            "SELECT count(*), coalesce(sum(bytes),0), (SELECT count(*) FROM lists) FROM packs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(database_error)?;
    if total_packs as usize >= MAX_PACKS
        || (total_bytes as usize).saturating_add(bytes) > wildcard_packs::MAX_CATALOG_BYTES
        || (total_lists as usize).saturating_add(lists.len()) > wildcard_packs::MAX_LISTS
    {
        return Err("The wildcard collection exceeds its storage limit".into());
    }
    tx.execute(
        "INSERT INTO packs (id, name, bytes) VALUES (?1, ?2, ?3)",
        params![id, name, bytes as i64],
    )
    .map_err(database_error)?;
    let mut add_list = tx
        .prepare("INSERT OR IGNORE INTO lists VALUES (?1, ?2, ?3)")
        .map_err(database_error)?;
    let mut add_choice = tx
        .prepare("INSERT INTO choices VALUES (?1, ?2, ?3)")
        .map_err(database_error)?;
    for (name, values) in lists {
        if add_list
            .execute(params![name, id, values.len() as i64])
            .map_err(database_error)?
            == 0
        {
            return Err(format!("Another pack already provides __{name}__"));
        }
        for (index, text) in values.into_iter().enumerate() {
            add_choice
                .execute(params![name, index as i64, text])
                .map_err(database_error)?;
        }
    }
    Ok(())
}

impl ChoiceCatalog for Transaction<'_> {
    fn count(&self, name: &str) -> Result<Option<usize>, String> {
        self.query_row("SELECT choices FROM lists WHERE name = ?1", [name], |row| {
            row.get::<_, u32>(0)
        })
        .optional()
        .map(|count| count.map(|count| count as usize))
        .map_err(database_error)
    }

    fn choice(&self, name: &str, index: usize) -> Result<String, String> {
        self.query_row(
            "SELECT text FROM choices WHERE name = ?1 AND position = ?2",
            params![name, index as i64],
            |row| row.get(0),
        )
        .map_err(database_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_large_source_and_persists_after_source_folder_moves() {
        let source = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let folder = source.path().join("pack");
        fs::create_dir(&folder).unwrap();
        let txt = folder.join("big.txt");
        let line = "A scenic background with mountains and clouds. ".repeat(6);
        let original = format!("{line}\n").repeat(5_000);
        fs::write(&txt, &original).unwrap();
        assert!(original.len() > 1024 * 1024);
        let yaml = format!(
            "large_yaml:\n{}",
            format!("  - {}\n", line.trim()).repeat(5_000)
        );
        assert!(yaml.len() > 1024 * 1024);
        fs::write(folder.join("large.yaml"), yaml).unwrap();
        let pack = wildcard_packs::load_pack(&folder).unwrap();
        let id = pack.id.clone();
        Store::open(profile.path()).unwrap().import(pack).unwrap();
        let moved = source.path().join("moved");
        fs::rename(&folder, &moved).unwrap();
        assert_eq!(fs::read_to_string(moved.join("big.txt")).unwrap(), original);
        let mut store = Store::open(profile.path()).unwrap();
        assert_eq!(store.summaries().unwrap()[0].lists["big"], 5_000);
        assert_eq!(store.summaries().unwrap()[0].lists["large_yaml"], 5_000);
        assert_eq!(store.page("big", 4_999).unwrap(), [line.trim()]);
        let resolved = store.expand("__big__", "", 8).unwrap();
        assert_eq!(
            serde_json::to_value(resolved).unwrap()["positive"],
            line.trim()
        );
        store.remove(&id).unwrap();
        assert!(store.summaries().unwrap().is_empty());
    }

    #[test]
    fn reimporting_a_folder_replaces_it_and_other_packs_keep_their_own_lists() {
        let profile = tempfile::tempdir().unwrap();
        let mut store = Store::open(profile.path()).unwrap();
        let make = |id: char, name: &str, key: &str, choice: &str| WildcardPack {
            id: id.to_string().repeat(64),
            name: name.to_owned(),
            lists: BTreeMap::from([(key.to_owned(), vec![choice.to_owned()])]),
        };
        store.import(make('a', "first", "one", "a one")).unwrap();
        store.import(make('b', "second", "two", "b two")).unwrap();
        // The same folder chosen again from a new location: new id, same name, overlapping lists.
        store.import(make('c', "first", "one", "c one")).unwrap();
        assert_eq!(store.summaries().unwrap().len(), 2);
        assert_eq!(store.page("one", 0).unwrap(), ["c one"]);
        assert_eq!(store.page("two", 0).unwrap(), ["b two"]);
        // A differently named pack may not take a list another pack owns, and the refusal is atomic.
        assert!(store.import(make('d', "third", "one", "d one")).is_err());
        assert_eq!(store.page("one", 0).unwrap(), ["c one"]);
        assert_eq!(store.summaries().unwrap().len(), 2);
        store.remove(&'c'.to_string().repeat(64)).unwrap();
        let rest = store.summaries().unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].name, "second");
        assert_eq!(store.page("one", 0).unwrap(), Vec::<String>::new());
    }
}
