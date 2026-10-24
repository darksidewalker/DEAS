use super::*;
use std::io::Write;

fn installed() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("DEAS ü executable");
    std::fs::write(&path, b"original executable").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, path)
}
fn staged(target: &Target) -> tempfile::NamedTempFile {
    let mut stage = tempfile::NamedTempFile::new_in(target.stage_dir()).unwrap();
    stage.write_all(b"new executable").unwrap();
    stage
}

#[test]
fn atomic_replace_keeps_open_original_and_unrelated_environment() {
    let (dir, path) = installed();
    let environment = dir.path().join("deas-environment/models");
    std::fs::create_dir_all(&environment).unwrap();
    std::fs::write(environment.join("keep"), b"untouched").unwrap();
    let target = Target::open(&path).unwrap();
    let mut old = target.old.try_clone().unwrap();
    target.publish(staged(&target)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"new executable");
    use std::io::Read;
    let mut bytes = Vec::new();
    old.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"original executable");
    assert_eq!(
        std::fs::read(environment.join("keep")).unwrap(),
        b"untouched"
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn rejects_symlinks_hardlinks_shared_parent_and_special_modes() {
    let (dir, path) = installed();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(Target::open(&link).is_err());
    std::fs::remove_file(&link).unwrap();
    std::fs::hard_link(&path, &link).unwrap();
    assert!(Target::open(&path).is_err());
    std::fs::remove_file(&link).unwrap();
    for mode in [0o777, 0o4755, 0o2755] {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(Target::open(&path).is_err());
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Target::open(&path).is_err());
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn concurrent_update_and_changed_target_fail_without_clobber() {
    let (_dir, path) = installed();
    let target = Target::open(&path).unwrap();
    assert!(Target::open(&path).is_err());
    let stage = staged(&target);
    let replacement = path.with_extension("new");
    std::fs::write(&replacement, b"someone else's newer executable").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert!(target.publish(stage).is_err());
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"someone else's newer executable"
    );
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
}

#[tokio::test]
async fn corrupt_download_retains_original_and_cleans_stage() {
    let (dir, path) = installed();
    let target = Target::open(&path).unwrap();
    let mut stage = staged(&target);
    let a = Asset {
        id: 1,
        url: String::new(),
        name: "deas-linux-amd64".into(),
        size: 14,
        digest: Some(format!("sha256:{}", "0".repeat(64))),
        browser_download_url: String::new(),
    };
    assert!(validate_binary(stage.as_file_mut(), 14, &a).is_err());
    drop(stage);
    assert_eq!(std::fs::read(&path).unwrap(), b"original executable");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn failed_rename_retains_old_inode_and_cleans_stage() {
    let (dir, path) = installed();
    let target = Target::open(&path).unwrap();
    let stage = staged(&target);
    // Force an absent staging source while leaving the installed executable intact.
    std::fs::remove_file(stage.path()).unwrap();
    assert!(target.publish(stage).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"original executable");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
