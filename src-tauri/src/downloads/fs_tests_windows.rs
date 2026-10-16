use super::Anchor;
use std::io::Write;

#[test]
fn anchored_writes_create_exclusively_and_never_overwrite() {
    let d = tempfile::tempdir().unwrap();
    assert!(Anchor::open(std::path::Path::new("relative")).is_err());
    let a = Anchor::open(d.path()).unwrap();
    assert_eq!(
        a.identity().unwrap(),
        Anchor::open(d.path()).unwrap().identity().unwrap()
    );
    a.absent("stage").unwrap();
    let sub = a.create("stage").unwrap();
    assert!(a.create("stage").is_err());
    assert!(a.absent("stage").is_err());
    for bad in ["", ".", "..", "a/b", "a\\b", "c:", "x\u{1}"] {
        assert!(sub.partial(bad).is_err(), "{bad:?}");
    }
    let mut f = sub.partial("part").unwrap();
    f.write_all(b"real").unwrap();
    assert!(sub.owns_partial("part", &f));
    assert!(sub.partial("part").is_err());
    sub.publish("part", "file").unwrap();
    assert!(!sub.owns_partial("part", &f));
    let mut f = sub.partial("next").unwrap();
    f.write_all(b"bad").unwrap();
    assert!(sub.publish("next", "file").is_err());
    sub.remove_partial("next");
    assert_eq!(std::fs::read(d.path().join("stage/file")).unwrap(), b"real");
    assert_eq!(
        std::fs::read_dir(d.path().join("stage")).unwrap().count(),
        1
    );
}

#[test]
fn replaced_or_non_directory_anchor_is_rejected() {
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("file");
    std::fs::write(&file, b"untouched").unwrap();
    assert!(Anchor::open(&file).is_err());
    let parent = d.path().join("parent");
    std::fs::create_dir(&parent).unwrap();
    let a = Anchor::open(&parent).unwrap();
    std::fs::rename(&parent, d.path().join("old")).unwrap();
    std::fs::create_dir(&parent).unwrap();
    assert!(a.create("stage").is_err());
    assert!(a.partial("part").is_err());
    assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
    assert_eq!(std::fs::read(&file).unwrap(), b"untouched");
}
