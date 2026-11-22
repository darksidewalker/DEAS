//! The library identity rows (M9d): what the stock library index knows about a model,
//! shaped for agents and stripped of everything local.
//!
//! One identity source, no second opinion:
//!
//! * The stock snapshot index, read through [`resolver::load_index`] with the plane's
//!   boot-wired source. This leg NEVER walks a model folder, never runs a scan and never
//!   probes a file header: the scan's published snapshot is the only truth it surfaces.
//!   Starting a scan is the other doors' job (`POST /v1/scan`, and `POST /v1/fingerprint`
//!   as its E10 alias).
//! * PRIVACY LAW: `LibraryEntry::path` is plane-side only. Every identity row is built
//!   field by field here — no door serializes a `LibraryEntry`, so a local filesystem
//!   path cannot reach the wire. The pin tests name this law.
//! * The family words are the stock declaration trio verbatim (override, CivitAI
//!   declaration, automatic detection) plus their precedence word. No fourth family word
//!   is invented, and the file-header classifier is deliberately NOT consulted: a listing
//!   answers what the index stored, and an index that stored nothing answers `null`.
//!   (The queue resolver may probe a header — one model, and the answer changes what it
//!   loads; a door that lists hundreds of rows must not.)

use serde_json::{json, Value};

use super::resolver::{self, LibraryEntry};

/// The one row shape every library identity door serves (`GET /v1/models` rows and
/// `GET /v1/resolve/{q}` matches are the same identity, so they are built once).
///
/// Reads no `path` field, by law: the load `name`, the category, the stored family
/// words, the fingerprint and the §9 handle derived from it. Since LEG M15 the row
/// also carries `triggerWords` — the sidecar trigger list the scan stored on the
/// snapshot (design 12.1 addendum, API-DESIGN.md:444). It is prompt metadata the
/// stock Workbench already shows (LibraryLoraDetails), never a path, so the privacy
/// law is untouched; an index that stored none answers the honest `null`.
///
/// Since LEG AF2-M19b (ruling E26) the row also carries `subfolder`: the model's
/// placement WITHIN the models root — `<category>/<directory of the load name>`,
/// always `/`-normalized, always relative. Ruling E26: "just the models and where
/// they live within that root, not the root itself" — the row says which subfolder
/// a model sits in and never utters the root, a drive, or an absolute path.
pub(crate) fn identity_row(entry: &LibraryEntry) -> Value {
    json!({
        "name": entry.name,
        "category": entry.category,
        "subfolder": subfolder_placement(entry),
        "family": stored_family(entry),
        "detectedFamily": entry.detected_family,
        "familyOverride": entry.family_override,
        "sha256": entry.sha256,
        "handle": resolver::handle_of(entry.sha256.as_deref()),
        "triggerWords": entry.trigger_words,
    })
}

/// The E26 root-relative placement word: the directory holding the model file,
/// expressed inside the models root as `<category>/<dir>` (the stock scan walks
/// `<root>/<category>` and stores `name` relative to the category folder —
/// `downloads_models.rs::describe`/`walk` — so the category plus the load name's
/// directory is exactly where the file lives within the root). Separator-normalized
/// to `/` whatever the walk stored; never absolute, never the root itself.
fn subfolder_placement(entry: &LibraryEntry) -> String {
    let name_dir = match entry.name.rfind(['/', '\\']) {
        Some(index) => &entry.name[..index],
        None => "",
    };
    std::iter::once(entry.category.as_str())
        .chain(std::iter::once(name_dir))
        .flat_map(|part| part.split(['/', '\\']))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// The family word the index itself states, in stock precedence order (override, then
/// explicit declaration, then automatic detection), `None` when the index stored none.
/// Deliberately the stored words only — no classifier call, no file read.
fn stored_family(entry: &LibraryEntry) -> Option<&str> {
    entry
        .family_override
        .as_deref()
        .or(entry.family.as_deref())
        .or(entry.detected_family.as_deref())
}

/// The `?q=` grammar: one case-insensitive substring, matched against the load name, the
/// category and each stored family word. Literal bytes only — no regex, no fuzzy law, no
/// percent-decoding (the plane's parameters stay literal).
pub(crate) fn matches_query(entry: &LibraryEntry, query: &str) -> bool {
    let needle = query.to_ascii_lowercase();
    [
        entry.name.as_str(),
        entry.category.as_str(),
        entry.family.as_deref().unwrap_or_default(),
        entry.detected_family.as_deref().unwrap_or_default(),
        entry.family_override.as_deref().unwrap_or_default(),
    ]
    .into_iter()
    .any(|field| field.to_ascii_lowercase().contains(&needle))
}

/// The filtered, deterministically ordered row set for `GET /v1/models`. The stock
/// reader returns its own walk order; this door sorts by category then name
/// (case-insensitive) so two calls over one index answer identically and a client can
/// page by eye without re-sorting.
pub(crate) fn model_rows(entries: &[LibraryEntry], query: Option<&str>) -> Vec<Value> {
    let mut selected: Vec<&LibraryEntry> = entries
        .iter()
        .filter(|entry| match query {
            // An empty needle is the honest no-filter case, never a match-nothing case.
            Some(needle) if !needle.is_empty() => matches_query(entry, needle),
            _ => true,
        })
        .collect();
    selected.sort_by(|left, right| {
        (
            left.category.to_ascii_lowercase(),
            left.name.to_ascii_lowercase(),
        )
            .cmp(&(
                right.category.to_ascii_lowercase(),
                right.name.to_ascii_lowercase(),
            ))
    });
    selected.iter().map(|entry| identity_row(entry)).collect()
}

/// The `libraryReady` half of `GET /v1/models/status`: the resolver can read an index
/// that is not empty. Honest by construction — an absent source, an unreadable snapshot
/// and a published-but-empty index all answer `false`, and this read never refreshes.
pub(crate) fn library_ready(source: Option<&resolver::IndexSource>) -> bool {
    source
        .is_some_and(|source| resolver::load_index(source).is_ok_and(|entries| !entries.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One index entry with a path a stranger must NEVER see on the wire.
    fn entry(category: &str, name: &str, sha: Option<&str>) -> LibraryEntry {
        LibraryEntry {
            category: category.to_owned(),
            name: name.to_owned(),
            path: format!("R:/private/models/{category}/{name}"),
            sha256: sha.map(str::to_owned),
            family: None,
            detected_family: None,
            family_override: None,
            component: None,
            trigger_words: None,
        }
    }

    /// PRIVACY LAW (law-named): neither identity door may emit a local path. The row is
    /// built field by field from the identity fields; the entry's own path — and its
    /// folder, and its drive letter — must appear nowhere in the serialized row.
    #[test]
    fn identity_row_never_leaks_a_local_path() {
        let mut model = entry(
            "checkpoints",
            "subdir/anima.safetensors",
            Some("a1b2c3d4e5f60718"),
        );
        model.detected_family = Some("anima".to_owned());
        let row = identity_row(&model);
        let text = row.to_string();
        assert!(
            !text.contains("R:/") && !text.contains("private") && !text.contains("models/"),
            "a local path reached the wire: {text}"
        );
        assert_eq!(row["name"], "subdir/anima.safetensors");
        assert_eq!(row["category"], "checkpoints");
        assert_eq!(row["family"], "anima");
        assert_eq!(row["handle"], "a1b2c3d4e5f6");
        assert_eq!(row["sha256"], "a1b2c3d4e5f60718");
        assert!(
            row.get("path").is_none(),
            "the row shape carries no path key at all"
        );
    }

    /// An entry the scan never fingerprinted has no handle and no fingerprint — the
    /// honest `null` pair, never a fabricated handle.
    #[test]
    fn an_unfingerprinted_entry_answers_null_fingerprint_and_handle() {
        let row = identity_row(&entry("vae", "wan_2.1_vae.safetensors", None));
        assert_eq!(row["sha256"], Value::Null);
        assert_eq!(row["handle"], Value::Null);
    }

    /// E26 (law-named, LEG AF2-M19b): the row carries the model's placement inside
    /// the models root — the category folder plus the load name's directory,
    /// `/`-normalized, relative only. The models root itself, its drive, and any
    /// absolute path stay off the wire; "where they live within that root, not the
    /// root itself".
    #[test]
    fn the_subfolder_word_is_root_relative_placement_never_the_root() {
        let nested = identity_row(&entry("loras", "mystyle/deep/krea.safetensors", None));
        assert_eq!(nested["subfolder"], "loras/mystyle/deep");
        let flat = identity_row(&entry("vae", "wan_2.1_vae.safetensors", None));
        assert_eq!(
            flat["subfolder"], "vae",
            "a file directly in a category folder still names its home inside the root"
        );
        // The scan stores the walk's native separators (Windows: `\\`); the word
        // normalizes to `/` so the placement grammar is one shape on every OS.
        let mut windows = entry("loras", "mystyle\\krea.safetensors", None);
        windows.name = "mystyle\\krea.safetensors".to_owned();
        assert_eq!(identity_row(&windows)["subfolder"], "loras/mystyle");
        // Never absolute, never the root: the fixture entry's path carries a drive
        // and a private folder — nothing of it may ride the subfolder word.
        for row in [
            identity_row(&entry("loras", "mystyle/deep/krea.safetensors", None)),
            identity_row(&entry("vae", "wan_2.1_vae.safetensors", None)),
        ] {
            let text = row["subfolder"]
                .as_str()
                .expect("subfolder rides")
                .to_owned();
            assert!(
                !text.contains(':') && !text.contains("R:/"),
                "a root leaked: {text}"
            );
            assert!(
                !text.starts_with('/') && !text.starts_with("\\\\"),
                "absolute: {text}"
            );
            assert!(
                !identity_row(&entry("loras", "mystyle/krea.safetensors", None))
                    .to_string()
                    .contains("private"),
                "the entry's own folder chain stays plane-side"
            );
        }
    }

    /// The stored family word follows the stock declaration precedence (override outranks
    /// declaration outranks detection) and NEVER calls the header classifier.
    #[test]
    fn stored_family_follows_the_stock_declaration_precedence() {
        let mut model = entry("diffusion_models", "anima.safetensors", None);
        model.detected_family = Some("anima".to_owned());
        model.family = Some("flux".to_owned());
        assert_eq!(stored_family(&model), Some("flux"));
        model.family_override = Some("sd15".to_owned());
        assert_eq!(stored_family(&model), Some("sd15"));
        let bare = entry("diffusion_models", "unknown.safetensors", None);
        assert_eq!(stored_family(&bare), None, "the index stored no word");
    }

    #[test]
    fn the_query_filter_reads_name_category_and_family_words() {
        let mut model = entry("diffusion_models", "Anima_Turbo.safetensors", None);
        model.detected_family = Some("anima-turbo".to_owned());
        let vae = entry("vae", "wan_2.1_vae.safetensors", None);
        for needle in ["anima", "TURBO", "vae", "diffusion_models", "wan_2.1"] {
            let matched = [model.clone(), vae.clone()]
                .into_iter()
                .filter(|entry| matches_query(entry, needle))
                .count();
            assert!(matched >= 1, "{needle} matches nothing");
        }
        assert_eq!(
            [model.clone(), vae.clone()]
                .into_iter()
                .filter(|entry| matches_query(entry, "lora"))
                .count(),
            0,
            "a needle outside the closed fields matches nothing"
        );
    }

    /// The listing is deterministic: two calls over one index answer in the same order,
    /// and the filter is applied before the sort, not after.
    #[test]
    fn model_rows_sort_deterministically_and_filter_first() {
        let mut entries = vec![
            entry("vae", "b_vae.safetensors", None),
            entry("diffusion_models", "Zeta.safetensors", None),
            entry("diffusion_models", "alpha.safetensors", None),
        ];
        entries[0].family_override = Some("anima".to_owned());
        let all = model_rows(&entries, None);
        let names: Vec<&str> = all
            .iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec!["alpha.safetensors", "Zeta.safetensors", "b_vae.safetensors"],
            "category order, then case-insensitive name order"
        );
        let filtered = model_rows(&entries, Some("anima"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["name"], "b_vae.safetensors");
        // An empty needle is the honest no-filter case, not a match-nothing case.
        assert_eq!(model_rows(&entries, Some("")).len(), 3);
    }
}
