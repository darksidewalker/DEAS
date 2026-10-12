//! Linux descriptor-anchored writes: no traversal, no symlink adoption, no clobber.
//! Other platforms fail closed until equivalent handle-based guards are implemented.
//! Creation requires an effective-user-owned parent without group/world write access,
//! including sticky shared directories. Opened staging children must be owned private
//! directories. This protects against cross-user substitution, not same-user adversaries.
#[cfg(target_os = "linux")]
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::ffi::OsStrExt,
};
use std::{fs::File, path::Path};

#[cfg(all(test, target_os = "linux"))]
#[path = "fs_tests.rs"]
mod tests;

#[cfg(target_os = "linux")]
pub struct Anchor(File);
#[cfg(not(target_os = "linux"))]
pub struct Anchor;
impl Anchor {
    #[cfg(target_os = "linux")]
    pub fn open(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("Parent must be absolute".into());
        }
        let root = CString::new("/").unwrap();
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("Cannot open parent".into());
        }
        let mut dir = Self(unsafe { File::from_raw_fd(fd) });
        for part in path.components().skip(1) {
            let std::path::Component::Normal(name) = part else {
                return Err("Unsafe parent path".into());
            };
            let name = CString::new(name.as_bytes()).map_err(|_| "Unsafe parent path")?;
            let fd = unsafe {
                libc::openat(
                    dir.0.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if fd < 0 {
                return Err("Parent components must be existing non-symlink directories".into());
            }
            dir = Self(unsafe { File::from_raw_fd(fd) });
        }
        Ok(dir)
    }
    #[cfg(not(target_os = "linux"))]
    pub fn open(_: &Path) -> Result<Self, String> {
        Err("Safe staged downloads currently require Linux".into())
    }

    pub fn identity(&self) -> Result<(u64, u64), String> {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let m = self.0.metadata().map_err(|_| "Cannot inspect parent")?;
            Ok((m.dev(), m.ino()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err("Unsupported platform".into())
        }
    }
    pub fn absent(&self, name: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            let name = CString::new(name).map_err(|_| "Unsafe filename")?;
            let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    self.0.as_raw_fd(),
                    name.as_ptr(),
                    st.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
            {
                Ok(())
            } else {
                Err("Target already exists or cannot be inspected".into())
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = name;
            Err("Unsupported platform".into())
        }
    }
    pub fn create(&self, name: &str) -> Result<Self, String> {
        #[cfg(target_os = "linux")]
        {
            self.create_checked(name, || {})
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = name;
            Err("Unsupported platform".into())
        }
    }
    #[cfg(target_os = "linux")]
    fn validate_directory(&self, private: bool) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = self.0.metadata().map_err(|_| "Cannot inspect directory")?;
        Self::validate_directory_metadata(metadata.uid(), metadata.mode(), private)
    }

    #[cfg(target_os = "linux")]
    fn validate_directory_metadata(uid: u32, mode: u32, private: bool) -> Result<(), String> {
        let forbidden = if private { 0o077 } else { 0o022 };
        if uid != unsafe { libc::geteuid() }
            || mode & libc::S_IFMT != libc::S_IFDIR
            || mode & forbidden != 0
        {
            return Err(
                "Download directory must be owned by the effective user with trusted permissions"
                    .into(),
            );
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn create_checked(&self, name: &str, after_mkdir: impl FnOnce()) -> Result<Self, String> {
        // Inspect the anchored descriptor immediately before any filesystem write.
        // O_NOFOLLOW alone cannot prevent mkdirat/openat substitution in shared parents.
        self.validate_directory(false)?;
        let name = CString::new(name).map_err(|_| "Unsafe filename")?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err("Cannot exclusively create new staging folder".into());
        }
        // A deterministic test seam; production passes a no-op. Never delete an
        // untrusted replacement on error because its identity is not ours to manage.
        after_mkdir();
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err("Cannot anchor staging folder".into());
        }
        let child = Self(unsafe { File::from_raw_fd(fd) });
        child.validate_directory(true)?;
        Ok(child)
    }

    pub fn partial(&self, name: &str) -> Result<File, String> {
        #[cfg(target_os = "linux")]
        {
            let name = CString::new(name).map_err(|_| "Unsafe filename")?;
            let fd = unsafe {
                libc::openat(
                    self.0.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_CLOEXEC
                        | libc::O_NOFOLLOW,
                    0o600,
                )
            };
            if fd < 0 {
                return Err("Cannot exclusively create partial".into());
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = name;
            Err("Unsupported platform".into())
        }
    }
    pub fn publish(&self, partial: &str, name: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            let partial = CString::new(partial).map_err(|_| "Unsafe filename")?;
            let name = CString::new(name).map_err(|_| "Unsafe filename")?;
            if unsafe {
                libc::linkat(
                    self.0.as_raw_fd(),
                    partial.as_ptr(),
                    self.0.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            } != 0
            {
                return Err("Cannot publish without overwrite".into());
            }
            unsafe { libc::unlinkat(self.0.as_raw_fd(), partial.as_ptr(), 0) };
            self.0
                .sync_all()
                .map_err(|_| "Cannot sync staging folder")?;
            Ok(())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (partial, name);
            Err("Unsupported platform".into())
        }
    }
    pub fn remove_partial(&self, name: &str) {
        #[cfg(target_os = "linux")]
        if let Ok(name) = CString::new(name) {
            unsafe { libc::unlinkat(self.0.as_raw_fd(), name.as_ptr(), 0) };
        }
        #[cfg(not(target_os = "linux"))]
        let _ = name;
    }
}
