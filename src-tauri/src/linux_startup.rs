// The test build's empty main() calls none of the startup hooks.
#![cfg_attr(test, allow(dead_code))]

use std::ffi::{c_char, c_int, c_void, CStr};
use std::path::Path;

/// Apply process-local compatibility defaults before GTK/WebKit or worker threads start.
/// Explicit user overrides (including empty values) remain authoritative.
pub fn configure() {
    for (name, value) in [
        // WebKitGTK's GPU (DMA-BUF) renderer dies with a Wayland protocol error under NVIDIA explicit sync;
        // disabling the sync keeps GPU rendering (CPU rendering made every control feel sluggish).
        ("__NV_DISABLE_EXPLICIT_SYNC", "1"),
        // GTK tries available backends in order; X11-only sessions skip Wayland.
        ("GDK_BACKEND", "wayland,x11"),
    ] {
        if std::env::var_os(name).is_none() {
            std::env::set_var(name, value);
        }
    }
    // NVIDIA's video DMA-BUF sink can display green frames; keep the rest of GPU rendering.
    if Path::new("/sys/module/nvidia").exists()
        && std::env::var_os("WEBKIT_GST_DMABUF_SINK_DISABLED").is_none()
    {
        std::env::set_var("WEBKIT_GST_DMABUF_SINK_DISABLED", "1");
    }
}

// Element WebKit needs, plugin file, bytes. See ../gstreamer/README.md for provenance.
#[cfg(target_arch = "x86_64")]
const GST_PLUGINS: [(&CStr, &str, &[u8]); 4] = [
    (
        c"autoaudiosink",
        "libgstautodetect.so",
        include_bytes!("../gstreamer/libgstautodetect.so"),
    ),
    (
        c"qtdemux",
        "libgstisomp4.so",
        include_bytes!("../gstreamer/libgstisomp4.so"),
    ),
    (
        c"matroskademux",
        "libgstmatroska.so",
        include_bytes!("../gstreamer/libgstmatroska.so"),
    ),
    (
        c"scaletempo",
        "libgstaudiofx.so",
        include_bytes!("../gstreamer/libgstaudiofx.so"),
    ),
];

/// WebKitGTK aborts on every `<video>` without `autoaudiosink` and cannot demux MP4/WebM
/// without gst-plugins-good. Expose bundled copies of exactly the elements the host lacks;
/// the inherited GST_PLUGIN_PATH reaches the WebKit web process. Call before any webview exists.
pub fn provide_gstreamer_plugins() {
    #[cfg(target_arch = "x86_64")]
    if let Err(error) = provide_gst_plugins() {
        log_gstreamer_failure(&error);
    }
}

#[cfg(target_arch = "x86_64")]
fn log_gstreamer_failure(error: &std::io::Error) {
    deas::logs::push(
        deas::logs::Source::Deas,
        &format!("ERROR: Linux playback plugin-cache: bundled plugins unavailable ({:?}); check cache permissions/storage", error.kind()),
    );
}

#[cfg(target_arch = "x86_64")]
fn provide_gst_plugins() -> std::io::Result<()> {
    let Some(present) = host_gst_elements(&GST_PLUGINS.map(|(element, ..)| element)) else {
        return Ok(());
    };
    let Some(cache) = std::env::var_os("XDG_CACHE_HOME")
        .filter(|dir| !dir.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".cache")))
    else {
        return Ok(());
    };
    let dir = cache.join("com.dasiwa.deas/gstreamer");
    let plugins: Vec<_> = GST_PLUGINS
        .iter()
        .zip(present)
        .map(|(&(_, name, bytes), present)| (name, (!present).then_some(bytes)))
        .collect();
    if sync_plugins(&dir, &plugins)? {
        let mut paths: Vec<_> = std::env::var_os("GST_PLUGIN_PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        paths.push(dir);
        std::env::set_var(
            "GST_PLUGIN_PATH",
            std::env::join_paths(paths).map_err(std::io::Error::other)?,
        );
    }
    Ok(())
}

/// Writes plugins given bytes and removes the rest, so a later host install is never shadowed
/// by a stale copy. Returns whether any plugin is provided.
fn sync_plugins(dir: &Path, plugins: &[(&str, Option<&[u8]>)]) -> std::io::Result<bool> {
    std::fs::create_dir_all(dir)?;
    for (name, bytes) in plugins {
        let path = dir.join(name);
        match bytes {
            Some(bytes) if std::fs::read(&path).ok().as_deref() != Some(*bytes) => {
                // Rename, never rewrite in place: another running DEAS may have the file mapped.
                let staged = dir.join(format!(".{name}.{}", std::process::id()));
                std::fs::write(&staged, bytes)?;
                std::fs::rename(&staged, &path)?;
            }
            Some(_) => {}
            None => match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
                _ => {}
            },
        }
    }
    Ok(plugins.iter().any(|(_, bytes)| bytes.is_some()))
}

/// Asks the host GStreamer (already a WebKitGTK dependency) which elements it can create.
fn host_gst_elements<const N: usize>(elements: &[&CStr; N]) -> Option<[bool; N]> {
    // SAFETY: documented GStreamer 1.x C signatures; the library handle is intentionally kept open.
    unsafe {
        let lib = libc::dlopen(
            c"libgstreamer-1.0.so.0".as_ptr(),
            libc::RTLD_NOW | libc::RTLD_GLOBAL,
        );
        if lib.is_null() {
            return None;
        }
        let symbol = |name: &CStr| libc::dlsym(lib, name.as_ptr());
        let (init, find, unref) = (
            symbol(c"gst_init_check"),
            symbol(c"gst_element_factory_find"),
            symbol(c"gst_object_unref"),
        );
        if init.is_null() || find.is_null() || unref.is_null() {
            return None;
        }
        let init: extern "C" fn(*mut c_int, *mut c_void, *mut c_void) -> c_int =
            std::mem::transmute(init);
        let find: extern "C" fn(*const c_char) -> *mut c_void = std::mem::transmute(find);
        let unref: extern "C" fn(*mut c_void) = std::mem::transmute(unref);
        if init(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            return None;
        }
        Some(elements.map(|element| {
            let factory = find(element.as_ptr());
            if !factory.is_null() {
                unref(factory);
            }
            !factory.is_null()
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{configure, host_gst_elements, sync_plugins};
    use std::path::Path;

    #[test]
    fn host_gstreamer_probe() {
        assert_eq!(
            host_gst_elements(&[c"fakesink", c"deas-no-such-element"]),
            Some([true, false])
        );
    }

    #[test]
    fn plugins_are_written_kept_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("libgsta.so");
        assert!(sync_plugins(dir.path(), &[("libgsta.so", Some(b"one"))]).unwrap());
        assert!(sync_plugins(dir.path(), &[("libgsta.so", Some(b"two"))]).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(!sync_plugins(dir.path(), &[("libgsta.so", None)]).unwrap());
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "no staged leftovers"
        );
    }

    // This binary's only environment-mutating test; no GTK or worker threads run.
    #[test]
    fn defaults_and_explicit_overrides() {
        let names = [
            "__NV_DISABLE_EXPLICIT_SYNC",
            "GDK_BACKEND",
            "WEBKIT_GST_DMABUF_SINK_DISABLED",
        ];
        let original = names.map(std::env::var_os);
        for name in names {
            std::env::remove_var(name);
        }
        configure();
        assert_eq!(std::env::var(names[0]).unwrap(), "1");
        assert_eq!(std::env::var(names[1]).unwrap(), "wayland,x11");
        assert_eq!(
            std::env::var_os(names[2]),
            Path::new("/sys/module/nvidia").exists().then(|| "1".into())
        );

        for backend in ["wayland", "x11", ""] {
            std::env::set_var(names[0], "0");
            std::env::set_var(names[1], backend);
            std::env::set_var(names[2], backend);
            configure();
            assert_eq!(std::env::var(names[0]).unwrap(), "0");
            assert_eq!(std::env::var(names[1]).unwrap(), backend);
            assert_eq!(std::env::var(names[2]).unwrap(), backend);
        }
        #[cfg(target_arch = "x86_64")]
        {
            super::log_gstreamer_failure(&std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "/private/path must not reach Logs",
            ));
            assert!(deas::logs::native_logs(0).iter().any(|entry| {
                entry.text.contains("ERROR: Linux playback plugin-cache:")
                    && entry.text.contains("PermissionDenied")
                    && !entry.text.contains("/private/path")
            }));
        }
        for (name, value) in names.into_iter().zip(original) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}
