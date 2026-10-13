/// Apply process-local compatibility defaults before GTK/WebKit or worker threads start.
/// Explicit user overrides (including empty values) remain authoritative.
pub fn configure() {
    for (name, value) in [
        // Avoid GBM/DMA-BUF allocation failures on otherwise working GPU desktops.
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
        // GTK tries available backends in order; X11-only sessions skip Wayland.
        ("GDK_BACKEND", "wayland,x11"),
    ] {
        if std::env::var_os(name).is_none() {
            std::env::set_var(name, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::configure;

    // This binary's only environment-mutating test; no GTK or worker threads run.
    #[test]
    fn defaults_and_explicit_overrides() {
        let names = ["WEBKIT_DISABLE_DMABUF_RENDERER", "GDK_BACKEND"];
        let original = names.map(std::env::var_os);
        for name in names {
            std::env::remove_var(name);
        }
        configure();
        assert_eq!(std::env::var(names[0]).unwrap(), "1");
        assert_eq!(std::env::var(names[1]).unwrap(), "wayland,x11");

        for backend in ["wayland", "x11", ""] {
            std::env::set_var(names[0], "0");
            std::env::set_var(names[1], backend);
            configure();
            assert_eq!(std::env::var(names[0]).unwrap(), "0");
            assert_eq!(std::env::var(names[1]).unwrap(), backend);
        }
        for (name, value) in names.into_iter().zip(original) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}
