//! Read local data packs through an explicit folder picker and expand Studio prompts.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{btree_map::Entry, BTreeMap, HashSet},
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) type Lists = BTreeMap<String, Vec<String>>;
const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_CATALOG_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const MAX_LISTS: usize = 16_384;
const MAX_PATH_DEPTH: usize = 12;
const MAX_REFS: u64 = 4096;
const MAX_PROMPT: usize = 16_384;

#[derive(Debug, Deserialize, Serialize)]
pub struct WildcardPack {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) lists: Lists,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ExpandedPrompts {
    positive: String,
    negative: String,
}

fn valid_name(name: &str) -> bool {
    name.len() <= 240
        && !name.contains("__")
        && !name.contains('\\')
        && !name.chars().any(char::is_control)
        && name.split('/').all(|part| {
            !part.trim().is_empty() && part.trim() == part && part != "." && part != ".."
        })
}

fn add_list(lists: &mut Lists, name: String, mut choices: Vec<String>) -> Result<(), String> {
    if !valid_name(&name) || choices.is_empty() {
        return Err(format!("Invalid or empty wildcard list: {name}"));
    }
    let at_limit = lists.len() == MAX_LISTS;
    match lists.entry(name) {
        Entry::Occupied(mut entry) => {
            let existing = entry.get_mut();
            let already_present: HashSet<_> = existing.iter().map(String::as_str).collect();
            choices.retain(|choice| !already_present.contains(choice.as_str()));
            existing.extend(choices);
        }
        Entry::Vacant(_) if at_limit => return Err("Too many wildcard lists".into()),
        Entry::Vacant(entry) => {
            entry.insert(choices);
        }
    }
    Ok(())
}

fn read_yaml(lists: &mut Lists, prefix: &str, value: Value, depth: usize) -> Result<(), String> {
    if depth > MAX_PATH_DEPTH {
        return Err("Wildcard YAML is nested too deeply".into());
    }
    let values = match value {
        Value::Object(entries) => {
            for (key, value) in entries {
                let name = if prefix.is_empty() {
                    key
                } else {
                    format!("{prefix}/{key}")
                };
                if !valid_name(&name) {
                    let display: String = name.chars().take(120).collect();
                    return Err(format!(
                        "Invalid wildcard YAML name starting with {display:?}"
                    ));
                }
                read_yaml(lists, &name, value, depth + 1)?;
            }
            return Ok(());
        }
        Value::Array(values) => values,
        scalar => vec![scalar],
    };
    let mut choices = Vec::new();
    for (index, value) in values.into_iter().enumerate() {
        let choice = match value {
            Value::String(text) => text.trim().to_owned(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            Value::Null => continue,
            Value::Array(_) | Value::Object(_) => {
                return Err(format!(
                    "Expected a text or scalar choice at {prefix}, item {}",
                    index + 1
                ));
            }
        };
        if !choice.is_empty() {
            choices.push(choice);
        }
    }
    if choices.is_empty() {
        Ok(())
    } else {
        add_list(lists, prefix.to_owned(), choices)
    }
}

fn link_like(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    metadata.is_symlink()
}

fn collect_files(
    dir: &Path,
    depth: usize,
    remaining: &mut usize,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_PATH_DEPTH {
        return Err("Wildcard folder is nested too deeply".into());
    }
    for entry in fs::read_dir(dir).map_err(|_| "Cannot read the wildcard directory")? {
        *remaining = remaining
            .checked_sub(1)
            .ok_or("Too many entries in the wildcard folder")?;
        let entry = entry.map_err(|_| "Cannot read a wildcard folder entry")?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "Cannot inspect a wildcard file")?;
        if link_like(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            collect_files(&path, depth + 1, remaining, files)?;
        } else if metadata.is_file() && extension(&path).is_some() {
            files.push(path);
        }
    }
    Ok(())
}

fn extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?;
    if ext.eq_ignore_ascii_case("txt") {
        Some("txt")
    } else if ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml") {
        Some("yaml")
    } else {
        None
    }
}

pub(crate) fn load_pack(path: &Path) -> Result<WildcardPack, String> {
    let root = dunce::canonicalize(path).map_err(|_| "Cannot open the chosen wildcard folder")?;
    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Choose a named wildcard folder")?;
    let id = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    let mut files = Vec::new();
    let mut remaining = MAX_LISTS;
    collect_files(&root, 0, &mut remaining, &mut files)?;
    files.sort();
    let mut size = 0;
    let mut lists = Lists::new();
    for path in files {
        let relative = path
            .strip_prefix(&root)
            .expect("collected path is under root");
        let file_name = relative.display();
        let canonical = dunce::canonicalize(&path).map_err(|_| "Cannot open a wildcard file")?;
        if !canonical.starts_with(&root) || canonical != path {
            return Err("A wildcard file changed location while importing".into());
        }
        let file = File::open(&canonical).map_err(|_| "Cannot open a wildcard file")?;
        if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
            return Err("Expected a regular wildcard file".into());
        }
        let mut data = Vec::new();
        file.take((MAX_PACK_BYTES - size + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|_| format!("Cannot read wildcard file {file_name}"))?;
        size += data.len();
        if size > MAX_PACK_BYTES {
            return Err("Wildcard pack exceeds 64 MiB".into());
        }
        let text = std::str::from_utf8(&data)
            .map_err(|_| format!("Wildcard file {file_name} must be UTF-8"))?;
        let data = crate::strip_bom(text);
        if extension(&path) == Some("txt") {
            let key = relative
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/");
            let choices: Vec<_> = data
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(str::to_owned)
                .collect();
            if !choices.is_empty() {
                add_list(&mut lists, key, choices)?;
            }
        } else {
            if data.lines().all(|line| {
                let line = line.trim_start();
                line.is_empty() || line.starts_with('#')
            }) {
                continue;
            }
            let mut options = serde_saphyr::Options::default();
            options.with_snippet = false;
            options.reject_unsupported_tags = true;
            options.duplicate_keys = serde_saphyr::DuplicateKeyPolicy::Error;
            options.merge_keys = serde_saphyr::MergeKeyPolicy::Error;
            options.budget = serde_saphyr::budget! {
                max_depth: 20,
                max_nodes: 1_000_000,
                max_events: 2_000_000,
            };
            let value: Value = serde_saphyr::from_str_with_options(data, options)
                .map_err(|_| format!("Invalid wildcard YAML in {file_name}"))?;
            if value.is_null() || value.as_array().is_some_and(Vec::is_empty) {
                continue;
            }
            if !value.is_object() {
                return Err(format!("Expected named lists in {file_name}"));
            }
            read_yaml(&mut lists, "", value, 0).map_err(|error| format!("{file_name}: {error}"))?;
        }
    }
    if lists.is_empty() {
        return Err("No wildcard lists found. Choose a folder with TXT or YAML lists.".into());
    }
    validate_catalog(&lists)?;
    Ok(WildcardPack {
        id,
        name: name.to_owned(),
        lists,
    })
}

pub(crate) fn validate_catalog(lists: &Lists) -> Result<usize, String> {
    let entries = lists
        .iter()
        .map(|(name, values)| {
            name.len() + values.iter().map(|value| value.len() + 2).sum::<usize>()
        })
        .sum::<usize>();
    if lists.len() > MAX_LISTS
        || entries > MAX_CATALOG_BYTES
        || lists.iter().any(|(name, values)| {
            !valid_name(name) || values.is_empty() || values.iter().any(|v| v.trim().is_empty())
        })
    {
        return Err("Invalid or oversized wildcard catalog".into());
    }
    Ok(entries)
}

pub(crate) trait ChoiceCatalog {
    fn count(&self, name: &str) -> Result<Option<usize>, String>;
    fn choice(&self, name: &str, index: usize) -> Result<String, String>;
}

#[cfg(test)]
impl ChoiceCatalog for Lists {
    fn count(&self, name: &str) -> Result<Option<usize>, String> {
        Ok(self.get(name).map(Vec::len))
    }

    fn choice(&self, name: &str, index: usize) -> Result<String, String> {
        Ok(self[name][index].clone())
    }
}

struct Expansion<'a, C> {
    lists: &'a C,
    seed: u32,
    side: u8,
    count: u64,
    stack: Vec<String>,
    output: String,
    units: usize,
}

struct InlineChoices {
    end: usize,
    separators: Vec<usize>,
}

fn inline_groups(text: &str) -> BTreeMap<usize, InlineChoices> {
    let mut groups = BTreeMap::new();
    let mut open = Vec::<(usize, Vec<usize>)>::new();
    for (index, character) in text.match_indices(['{', '|', '}']) {
        match character {
            "{" => open.push((index, Vec::new())),
            "|" => {
                if let Some((_, separators)) = open.last_mut() {
                    separators.push(index);
                }
            }
            "}" => {
                if let Some((start, separators)) = open.pop() {
                    // ${name} belongs to the separate prompt-variable syntax.
                    if !separators.is_empty() && !text[..start].ends_with('$') {
                        groups.insert(
                            start,
                            InlineChoices {
                                end: index,
                                separators,
                            },
                        );
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    groups
}

impl<C: ChoiceCatalog> Expansion<'_, C> {
    fn append(&mut self, text: &str) -> Result<(), String> {
        self.units += text.encode_utf16().count();
        if self.units > MAX_PROMPT {
            return Err("Expanded wildcard prompt exceeds 16384 characters".into());
        }
        self.output.push_str(text);
        Ok(())
    }

    fn render(&mut self, text: &str, depth: usize) -> Result<(), String> {
        let groups = inline_groups(text);
        let mut names = text.match_indices("__").map(|(index, _)| index).peekable();
        let mut offset = 0;
        while offset < text.len() {
            while names.peek().is_some_and(|&index| index < offset) {
                names.next();
            }
            let named = names.peek().copied();
            if let Some((&start, group)) = groups.range(offset..).next() {
                if named.is_none_or(|index| start < index) {
                    self.append(&text[offset..start])?;
                    let index =
                        self.choose(&text[start..=group.end], group.separators.len() + 1, depth)?;
                    let first = if index == 0 {
                        start
                    } else {
                        group.separators[index - 1]
                    };
                    let last = group.separators.get(index).copied().unwrap_or(group.end);
                    self.render(text[first + 1..last].trim(), depth + 1)?;
                    offset = group.end + 1;
                    continue;
                }
            }
            let Some(start) = named else { break };
            self.append(&text[offset..start])?;
            offset = start + 2;
            names.next();
            if let Some(end) = names.peek().copied() {
                let name = &text[offset..end];
                if valid_name(name) {
                    self.pick(name, depth)?;
                    offset = end + 2;
                    continue;
                }
            }
            self.append("__")?;
        }
        self.append(&text[offset..])
    }

    fn pick(&mut self, name: &str, depth: usize) -> Result<(), String> {
        let unknown = || format!("Unknown wildcard __{name}__");
        let resolved;
        let (name, choices) = if let Some(count) = self.lists.count(name)?.filter(|n| *n > 0) {
            (name, count)
        } else {
            let (folder, _) = self
                .stack
                .last()
                .and_then(|parent| parent.rsplit_once('/'))
                .filter(|_| !name.contains('/'))
                .ok_or_else(&unknown)?;
            resolved = format!("{folder}/{name}");
            let count = self
                .lists
                .count(&resolved)?
                .filter(|n| *n > 0)
                .ok_or_else(unknown)?;
            (resolved.as_str(), count)
        };
        if self.stack.iter().any(|parent| parent == name) {
            return Err(format!("Circular wildcard reference at __{name}__"));
        }
        let index = self.choose(name, choices, depth)?;
        let choice = self.lists.choice(name, index)?;
        self.stack.push(name.to_owned());
        self.render(&choice, depth + 1)?;
        self.stack.pop();
        Ok(())
    }

    fn choose(&mut self, name: &str, choices: usize, depth: usize) -> Result<usize, String> {
        if depth >= MAX_PATH_DEPTH || self.count >= MAX_REFS {
            return Err(
                "Wildcard expansion is too deeply nested or has too many references".into(),
            );
        }
        let mut hash = Sha256::new();
        hash.update(self.seed.to_le_bytes());
        hash.update([self.side]);
        hash.update(self.count.to_le_bytes());
        hash.update(name.as_bytes());
        let digest = hash.finalize();
        let number = u64::from_le_bytes(digest[..8].try_into().expect("SHA-256 has 32 bytes"));
        self.count += 1;
        Ok((number % choices as u64) as usize)
    }
}

#[cfg(test)]
pub(crate) fn expand(
    lists: &Lists,
    positive: &str,
    negative: &str,
    seed: u32,
) -> Result<ExpandedPrompts, String> {
    validate_catalog(lists)?;
    expand_catalog(lists, positive, negative, seed)
}

pub(crate) fn expand_catalog(
    lists: &impl ChoiceCatalog,
    positive: &str,
    negative: &str,
    seed: u32,
) -> Result<ExpandedPrompts, String> {
    let render = |text: &str, side: u8| {
        let mut expansion = Expansion {
            lists,
            seed,
            side,
            count: 0,
            stack: Vec::new(),
            output: String::new(),
            units: 0,
        };
        expansion.render(text, 0)?;
        Ok::<_, String>(expansion.output)
    };
    Ok(ExpandedPrompts {
        positive: render(positive, 0)?,
        negative: render(negative, 1)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_choices_use_the_seed_and_need_no_imported_lists() {
        let lists = Lists::new();
        let prompt = "score {1|2|3}, {red|{blue|green}}, {literal}, ${variable}";
        let expand_seed = |seed| expand(&lists, prompt, "{blurry|grainy}", seed).unwrap();
        let first = expand_seed(123);
        assert_eq!(first, expand_seed(123));
        let picks: std::collections::HashSet<_> =
            (0..48).map(|seed| expand_seed(seed).positive).collect();
        assert!(picks.len() > 3);
        assert!(picks
            .iter()
            .all(|pick| { pick.ends_with(", {literal}, ${variable}") && !pick.contains('|') }));
        assert!(["blurry", "grainy"].contains(&first.negative.as_str()));
        assert_eq!(
            expand(&lists, "a lone {1|2", "", 0).unwrap().positive,
            "a lone {1|2"
        );
    }

    #[test]
    fn inline_choices_compose_with_named_wildcards() {
        let lists = Lists::from([
            ("outfit".to_owned(), vec!["{blue|green} coat".to_owned()]),
            (
                "scene".to_owned(),
                vec!["{__outfit__|__outfit__}".to_owned()],
            ),
        ]);
        let prompts = expand(&lists, "__scene__", "", 0).unwrap();
        assert!(["blue coat", "green coat"].contains(&prompts.positive.as_str()));
    }

    #[test]
    fn resolves_short_references_to_lists_in_the_same_folder() {
        let source = tempfile::tempdir().unwrap();
        let folder = source.path().join("scenes/forest");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("weather.txt"), "{__clear__|__rain__}\n").unwrap();
        fs::write(folder.join("clear.txt"), "sunny with __sky__\n").unwrap();
        fs::write(folder.join("rain.txt"), "rain with __sky__\n").unwrap();
        fs::write(folder.join("sky.txt"), "clouds\n").unwrap();
        fs::write(folder.join("cycle.txt"), "__cycle__\n").unwrap();
        fs::write(source.path().join("sky.txt"), "mist\n").unwrap();

        let profile = tempfile::tempdir().unwrap();
        let mut store = crate::wildcard_store::Store::open(profile.path()).unwrap();
        store.import(load_pack(source.path()).unwrap()).unwrap();
        let picks: HashSet<_> = (0..24)
            .map(|seed| {
                store
                    .expand("__scenes/forest/weather__", "", seed)
                    .unwrap()
                    .positive
            })
            .collect();
        assert_eq!(
            picks,
            HashSet::from(["sunny with mist".into(), "rain with mist".into()])
        );
        assert_eq!(
            store
                .expand("__scenes/forest/sky__", "", 0)
                .unwrap()
                .positive,
            "clouds"
        );
        assert_eq!(
            store.expand("__clear__", "", 0).unwrap_err(),
            "Unknown wildcard __clear__"
        );
        assert_eq!(
            store.expand("__scenes/forest/cycle__", "", 0).unwrap_err(),
            "Circular wildcard reference at __scenes/forest/cycle__"
        );
    }

    #[test]
    fn imports_reusable_txt_and_nested_yaml_without_changing_inputs() {
        let folder = tempfile::TempDir::new().unwrap();
        let root = folder.path();
        let text = "# comment\r\n__worlds/sky/scene__\r\n";
        let yaml = "worlds:\n  sky:\n    scene:\n      - __worlds/sky/outfit__, a sky city\n    outfit:\n      - a blue coat\n      - a green coat\n";
        fs::write(root.join("scene.txt"), text).unwrap();
        fs::write(root.join("scenes.yaml"), yaml).unwrap();
        fs::write(
            root.join("poses.yml"),
            r#"{"poses":{"casual":["one hand in a pocket"]}}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("locations/indoors")).unwrap();
        fs::write(root.join("locations/indoors/studio.txt"), "quiet studio").unwrap();
        fs::write(root.join("ignored.md"), "ignored").unwrap();
        let pack = load_pack(root).unwrap();
        assert_eq!(pack.lists.len(), 5);
        assert_eq!(pack.lists["poses/casual"], ["one hand in a pocket"]);
        assert_eq!(pack.lists["locations/indoors/studio"], ["quiet studio"]);
        let original = expand(&pack.lists, "portrait, __scene__", "", 12).unwrap();
        assert!(original.positive.ends_with("coat, a sky city"));
        assert_eq!(
            original,
            expand(&pack.lists, "portrait, __scene__", "", 12).unwrap()
        );
        assert_eq!(load_pack(root).unwrap().id, pack.id);
        assert_eq!(fs::read_to_string(root.join("scene.txt")).unwrap(), text);
        assert_eq!(fs::read_to_string(root.join("scenes.yaml")).unwrap(), yaml);
    }

    #[test]
    fn imports_scalar_yaml_and_ignores_empty_placeholders() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pack.yaml");
        let yaml = "style:\n  lighting: soft moonlight\n  blank:\n  empty: []\n  no_text: '  '\n\
                    amount: 5\nflag: false\ncolors: [blue, null, 7, '']\nreference: __style/lighting__\n";
        fs::write(&file, yaml).unwrap();
        fs::write(dir.path().join("placeholder.yaml"), "# Reserved\n").unwrap();
        fs::write(dir.path().join("placeholder.txt"), "# Reserved\n").unwrap();
        let pack = load_pack(dir.path()).unwrap();
        assert_eq!(pack.lists.len(), 5);
        assert_eq!(pack.lists["amount"], ["5"]);
        assert_eq!(pack.lists["flag"], ["false"]);
        assert_eq!(pack.lists["colors"], ["blue", "7"]);
        let prompts = expand(&pack.lists, "__reference__", "", 0).unwrap();
        assert_eq!(prompts.positive, "soft moonlight");
        assert_eq!(fs::read_to_string(file).unwrap(), yaml);
    }

    #[test]
    fn imports_slash_separated_yaml_keys_as_wildcard_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pack.yaml");
        let yaml =
            "'worlds/sky':\n  'weather/color': [blue]\n  scene: __worlds/sky/weather/color__ sky\n";
        fs::write(&file, yaml).unwrap();
        let pack = load_pack(dir.path()).unwrap();
        let prompts = expand(&pack.lists, "__worlds/sky/scene__", "", 0).unwrap();
        assert_eq!(prompts.positive, "blue sky");
        assert_eq!(fs::read_to_string(file).unwrap(), yaml);
    }

    #[test]
    fn combines_overlapping_lists_in_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("a_trail.yaml"),
            "forest:\n  trail:\n    weather: [sunny, sunny, overcast]\n",
        )
        .unwrap();
        fs::write(
            root.join("trail_extra.yml"),
            "'forest/trail/weather': [overcast, foggy, foggy]\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("forest/trail")).unwrap();
        fs::write(root.join("forest/trail/weather.txt"), "sunny\nsnowy\n").unwrap();
        let pack = load_pack(root).unwrap();
        let name = "forest/trail/weather";
        let merged = ["sunny", "sunny", "overcast", "snowy", "foggy", "foggy"];
        assert_eq!(pack.lists.len(), 1);
        assert_eq!(pack.lists[name], merged);

        let local = tempfile::tempdir().unwrap();
        let mut store = crate::wildcard_store::Store::open(local.path()).unwrap();
        store.import(pack).unwrap();
        store.import(load_pack(root).unwrap()).unwrap();
        assert_eq!(store.page(name, 0).unwrap(), merged);
        let prompt = store.expand("__forest/trail/weather__", "", 0).unwrap();
        assert!(merged.contains(&prompt.positive.as_str()));
    }

    #[test]
    fn invalid_yaml_path_reports_the_file_and_name() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pack.yaml"), "'worlds/../sky': [blue]").unwrap();
        let error = load_pack(dir.path()).unwrap_err();
        assert!(error.starts_with("pack.yaml: "));
        assert!(error.contains("worlds/../sky"));
    }

    #[test]
    fn invalid_yaml_choice_reports_its_file_and_key() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(
            dir.path().join("nested").join("shape.yaml"),
            "mood: [calm, {level: low}]",
        )
        .unwrap();
        let error = load_pack(dir.path()).unwrap_err().replace('\\', "/");
        assert!(error.starts_with("nested/shape.yaml: "));
        assert!(error.ends_with("at mood, item 2"));
    }

    #[test]
    fn reports_missing_and_circular_references_and_bounds_output() {
        let lists = Lists::from([
            ("cycle".to_owned(), vec!["__cycle__".to_owned()]),
            (
                "big".to_owned(),
                vec![String::from("🌱").repeat(MAX_PROMPT)],
            ),
        ]);
        assert!(expand(&lists, "__cycle__", "", 0)
            .unwrap_err()
            .contains("Circular"));
        assert!(expand(&lists, "", "__missing__", 0)
            .unwrap_err()
            .contains("Unknown"));
        assert!(expand(&lists, "__big__", "", 0)
            .unwrap_err()
            .contains("16384"));
    }
}
