//! Read-only media browsing for the media library plugin: list a folder or
//! describe dropped paths. Never writes, moves or opens files.
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 5000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub symlink: bool,
    pub media: Option<&'static str>,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<MediaEntry>,
    pub truncated: bool,
}

pub fn media_kind(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "svg" | "tif" | "tiff" => {
            Some("image")
        }
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "mpg" | "mpeg" => Some("video"),
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Some("audio"),
        _ => None,
    }
}

/// Follows symlinks for the kind so linked folders browse like real ones; the flag stays visible.
fn describe(path: &Path) -> Result<MediaEntry, String> {
    let shown = path.to_str().ok_or("Path is not valid UTF-8")?.to_owned();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| shown.clone());
    let symlink = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
    let dir = meta.is_dir();
    Ok(MediaEntry {
        media: if dir { None } else { media_kind(&name) },
        kind: if dir { "directory" } else { "file" },
        size: if dir { 0 } else { meta.len() },
        name,
        path: shown,
        symlink,
    })
}

fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Path must be absolute".into());
    }
    Ok(path)
}

pub fn list_directory(path: &Path) -> Result<MediaListing, String> {
    let shown = path.to_str().ok_or("Path is not valid UTF-8")?.to_owned();
    let read = std::fs::read_dir(path).map_err(|e| format!("{shown}: {e}"))?;
    let mut entries = vec![];
    let mut truncated = false;
    for entry in read.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue; // shortcut: hidden entries are skipped, add a toggle when someone needs them
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        // Unreadable entries (dangling links, permission errors) are omitted, not fatal.
        if let Ok(described) = describe(&entry.path()) {
            entries.push(described);
        }
    }
    entries.sort_by(|a, b| {
        (a.kind != "directory")
            .cmp(&(b.kind != "directory"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(MediaListing {
        parent: path.parent().and_then(|p| p.to_str()).map(str::to_owned),
        path: shown,
        entries,
        truncated,
    })
}

/// Empty path opens the user's home directory.
#[tauri::command]
pub fn native_media_list(path: String) -> Result<MediaListing, String> {
    let target = if path.is_empty() {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or("No home directory is known")?
    } else {
        absolute(&path)?
    };
    list_directory(&target)
}

/// Describe dropped absolute paths; folders come back as directories the UI can open.
#[tauri::command]
pub fn native_media_describe(paths: Vec<String>) -> Result<Vec<MediaEntry>, String> {
    paths
        .iter()
        .take(MAX_ENTRIES)
        .map(|p| describe(&absolute(p)?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_media_by_extension_case_insensitively() {
        assert_eq!(media_kind("a.PNG"), Some("image"));
        assert_eq!(media_kind("clip.mkv"), Some("video"));
        assert_eq!(media_kind("song.flac"), Some("audio"));
        assert_eq!(media_kind("notes.txt"), None);
        assert_eq!(media_kind("noext"), None);
    }

    #[cfg(unix)]
    #[test]
    fn lists_sorted_entries_and_browses_symlinked_folders() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("b.mp4"), b"v").unwrap();
        std::fs::write(real.join("A.png"), b"i").unwrap();
        std::fs::write(real.join(".hidden"), b"").unwrap();
        std::os::unix::fs::symlink(&real, root.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(root.path().join("missing"), root.path().join("dangling"))
            .unwrap();

        let top = list_directory(root.path()).unwrap();
        assert_eq!(
            top.entries
                .iter()
                .map(|e| (&*e.name, e.kind, e.symlink))
                .collect::<Vec<_>>(),
            vec![("linked", "directory", true), ("real", "directory", false)]
        );
        assert_eq!(
            top.parent.as_deref(),
            root.path().parent().unwrap().to_str()
        );

        let linked = list_directory(&root.path().join("linked")).unwrap();
        assert_eq!(
            linked
                .entries
                .iter()
                .map(|e| (&*e.name, e.media))
                .collect::<Vec<_>>(),
            vec![("A.png", Some("image")), ("b.mp4", Some("video"))]
        );
        assert_eq!(linked.entries[0].size, 1);

        assert!(native_media_list("relative".into()).is_err());
        assert!(native_media_list(root.path().join("nope").to_str().unwrap().into()).is_err());
        let dropped = native_media_describe(vec![real.to_str().unwrap().into()]).unwrap();
        assert_eq!(dropped[0].kind, "directory");
        assert!(native_media_describe(vec!["relative".into()]).is_err());
    }
}
