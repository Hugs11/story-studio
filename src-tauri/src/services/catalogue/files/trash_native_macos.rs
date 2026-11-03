//! Cocoa retains structured NSError evidence in this nonmutating query. The
//! trash crate erases that evidence when a later mutation returns an error.
use super::Outcome;
#[derive(Clone, Copy, Debug)]
pub(crate) enum Domain {
    Cocoa,
    Posix,
    Other,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct NativeError {
    pub domain: Domain,
    pub code: isize,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Probe {
    pub succeeded: bool,
    pub error: Option<NativeError>,
}
pub(super) fn classify(probe: Probe) -> Option<Outcome> {
    match (probe.succeeded, probe.error) {
        (true, None) => None,
        // Foundation documents NSFeatureUnsupportedError for volumes without a
        // trash directory. Only its exact Cocoa domain/code is an authorization.
        (
            false,
            Some(NativeError {
                domain: Domain::Cocoa,
                code: 3328,
            }),
        ) => Some(Outcome::UnavailableForTarget),
        (
            false,
            Some(NativeError {
                domain: Domain::Cocoa,
                code: 257 | 513,
            }),
        )
        | (
            false,
            Some(NativeError {
                domain: Domain::Posix,
                code: 1 | 13,
            }),
        ) => Some(Outcome::Failed),
        _ => Some(Outcome::Uncertain),
    }
}
#[cfg(target_os = "macos")]
pub(super) fn probe(path: &std::path::Path) -> Probe {
    runtime::probe(path)
}
#[cfg(target_os = "macos")]
mod runtime {
    use super::{Domain, NativeError, Probe};
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        os::unix::ffi::OsStrExt,
        path::Path,
        ptr,
    };
    type Object = *mut c_void;
    type Selector = *const c_void;
    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Selector;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> Object;
        fn objc_autoreleasePoolPop(pool: Object);
    }
    #[link(name = "Foundation", kind = "framework")]
    unsafe extern "C" {
        static NSCocoaErrorDomain: Object;
        static NSPOSIXErrorDomain: Object;
    }
    struct Pool(Object);
    impl Drop for Pool {
        fn drop(&mut self) {
            unsafe {
                objc_autoreleasePoolPop(self.0);
            }
        }
    }
    unsafe fn object(receiver: Object, selector: &CStr) -> Object {
        // objc_msgSend must be cast to the exact method ABI on Apple Silicon.
        let send: unsafe extern "C" fn(Object, Selector) -> Object =
            unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        unsafe { send(receiver, sel_registerName(selector.as_ptr())) }
    }
    unsafe fn equal(receiver: Object, other: Object) -> bool {
        let send: unsafe extern "C" fn(Object, Selector, Object) -> bool =
            unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        unsafe {
            send(
                receiver,
                sel_registerName(c"isEqualToString:".as_ptr()),
                other,
            )
        }
    }
    pub(super) fn probe(path: &Path) -> Probe {
        let unknown = Probe {
            succeeded: false,
            error: None,
        };
        let Ok(path_c) = CString::new(path.as_os_str().as_bytes()) else {
            return unknown;
        };
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(e) => {
                return Probe {
                    succeeded: false,
                    error: e.raw_os_error().map(|code| NativeError {
                        domain: Domain::Posix,
                        code: code as isize,
                    }),
                }
            }
        };
        // Every Foundation object below is autoreleased and remains alive until
        // structured error domain/code have been copied into plain Rust values.
        unsafe {
            let _pool = Pool(objc_autoreleasePoolPush());
            let url_class = objc_getClass(c"NSURL".as_ptr());
            let manager_class = objc_getClass(c"NSFileManager".as_ptr());
            if url_class.is_null() || manager_class.is_null() {
                return unknown;
            }
            let make_url: unsafe extern "C" fn(
                Object,
                Selector,
                *const c_char,
                bool,
                Object,
            ) -> Object = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let url = make_url(
                url_class,
                sel_registerName(
                    c"fileURLWithFileSystemRepresentation:isDirectory:relativeToURL:".as_ptr(),
                ),
                path_c.as_ptr(),
                metadata.is_dir(),
                ptr::null_mut(),
            );
            let manager = object(manager_class, c"defaultManager");
            if url.is_null() || manager.is_null() {
                return unknown;
            }
            let query: unsafe extern "C" fn(
                Object,
                Selector,
                *mut isize,
                usize,
                usize,
                Object,
                *mut Object,
            ) -> bool = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let mut relationship = 0isize;
            let mut error = ptr::null_mut();
            // NSTrashDirectory=102; domain=0 chooses the trash appropriate for
            // this exact item's volume. This query neither creates nor moves it.
            let succeeded = query(
                manager,
                sel_registerName(
                    c"getRelationship:ofDirectory:inDomain:toItemAtURL:error:".as_ptr(),
                ),
                &mut relationship,
                102,
                0,
                url,
                &mut error,
            );
            let error = if error.is_null() {
                None
            } else {
                let domain_object = object(error, c"domain");
                let domain = if equal(domain_object, NSCocoaErrorDomain) {
                    Domain::Cocoa
                } else if equal(domain_object, NSPOSIXErrorDomain) {
                    Domain::Posix
                } else {
                    Domain::Other
                };
                let code: unsafe extern "C" fn(Object, Selector) -> isize =
                    std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
                Some(NativeError {
                    domain,
                    code: code(error, sel_registerName(c"code".as_ptr())),
                })
            };
            Probe { succeeded, error }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn macos_trash_probe_preserves_native_domains_and_codes() {
        assert_eq!(
            classify(Probe {
                succeeded: true,
                error: None
            }),
            None
        );
        let failure = |domain, code| {
            classify(Probe {
                succeeded: false,
                error: Some(NativeError { domain, code }),
            })
        };
        assert_eq!(
            failure(Domain::Cocoa, 3328),
            Some(Outcome::UnavailableForTarget)
        );
        for (domain, code) in [
            (Domain::Cocoa, 257),
            (Domain::Cocoa, 513),
            (Domain::Posix, 1),
            (Domain::Posix, 13),
        ] {
            assert_eq!(failure(domain, code), Some(Outcome::Failed));
        }
        for (domain, code) in [
            (Domain::Other, 3328),
            (Domain::Posix, 3328),
            (Domain::Cocoa, 4),
            (Domain::Posix, 2),
            (Domain::Cocoa, 640),
        ] {
            assert_eq!(failure(domain, code), Some(Outcome::Uncertain));
        }
        assert_eq!(
            classify(Probe {
                succeeded: false,
                error: None
            }),
            Some(Outcome::Uncertain)
        );
        assert_eq!(
            classify(Probe {
                succeeded: true,
                error: Some(NativeError {
                    domain: Domain::Cocoa,
                    code: 3328
                })
            }),
            Some(Outcome::Uncertain)
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
#[test]
fn macos_native_trash_query_returns_structured_evidence_without_mutation() {
    let root =
        std::env::temp_dir().join(format!("story-studio-trash-probe-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("native-probe.zip");
    let bytes = b"synthetic-read-only-trash-probe";
    std::fs::write(&path, bytes).unwrap();
    let result = probe(&path);
    assert!(
        result.succeeded != result.error.is_some(),
        "native query must yield either a relationship or structured NSError evidence"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(root).unwrap();
}
