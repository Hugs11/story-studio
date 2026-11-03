//! Windows Shell can silently fall back to destruction. Veto non-recycling
//! PreDeleteItem callbacks; never delegate this operation to junkyard's sink.
use super::Outcome;
const RECYCLE: u32 = 0x80; // TSF_DELETE_RECYCLE_IF_POSSIBLE
const ABORT: i32 = 0x80004004u32 as i32; // E_ABORT
const FORCE_NUKE: i32 = 0x80270036u32 as i32;
const TOO_BIG: i32 = 0x80270037u32 as i32;
const BIN_MISSING: i32 = 0x8027003au32 as i32;

#[derive(Default)]
struct Progress {
    vetoed: bool,
    attempted: bool,
    recycled: bool,
    failure: Option<i32>,
    #[cfg(windows)]
    trash_path: Option<std::path::PathBuf>,
}
impl Progress {
    fn pre_delete(&mut self, flags: u32) -> i32 {
        if flags & RECYCLE == 0 {
            self.vetoed = true;
            return ABORT;
        }
        self.attempted = true;
        0
    }
    fn post_delete(&mut self, result: i32, recycled_item: bool) {
        if result < 0 {
            self.failure = Some(result);
        } else {
            self.recycled = recycled_item;
        }
    }
    fn outcome(&self, result: i32, aborted: bool, source_present: bool) -> Outcome {
        // Unavailability is usable only when no recycling has taken place and
        // the original still exists. Unknown/permission errors never qualify.
        if source_present && !self.recycled {
            if (self.vetoed && !self.attempted)
                || matches!(
                    self.failure.unwrap_or(result),
                    FORCE_NUKE | TOO_BIG | BIN_MISSING
                )
            {
                return Outcome::UnavailableForTarget;
            }
            if self.failure.unwrap_or(result) == 0x80070005u32 as i32 {
                return Outcome::Failed;
            }
        }
        if result >= 0 && !aborted && self.recycled && !source_present {
            Outcome::Removed
        } else {
            Outcome::Uncertain
        }
    }
}

#[cfg(test)]
pub(super) fn qualify_test_callback(flags: u32, error: i32) -> Outcome {
    let mut p = Progress::default();
    if p.pre_delete(flags) >= 0 {
        p.post_delete(error, false);
    }
    p.outcome(error, true, true)
}

#[cfg(windows)]
pub(super) fn discard(path: &std::path::Path) -> (Outcome, Option<std::path::PathBuf>) {
    native::discard(path)
}

// These ABI declarations are confined here: Windows requires a per-item COM
// callback before deletion, and the allowed dependency exposes no such hook.
#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr,
        sync::{
            atomic::{AtomicU32, Ordering},
            Mutex,
        },
    };
    type Ptr = *mut c_void;
    #[repr(C)]
    #[derive(PartialEq, Eq)]
    struct Guid(u32, u16, u16, [u8; 8]);
    const UNKNOWN: Guid = Guid(0, 0, 0, [0xc0, 0, 0, 0, 0, 0, 0, 0x46]);
    const SINK: Guid = Guid(
        0x04b0f1a7,
        0x9490,
        0x44bc,
        [0x96, 0xe1, 0x42, 0x96, 0xa3, 0x12, 0x52, 0xe2],
    );
    const OPERATION: Guid = Guid(
        0x947aab5f,
        0x0a5c,
        0x4c13,
        [0xb4, 0xd6, 0x4b, 0xf7, 0x83, 0x6f, 0xc9, 0xf8],
    );
    const CLASS: Guid = Guid(
        0x3ad05575,
        0x8857,
        0x4850,
        [0x92, 0x77, 0x11, 0xb8, 0x5b, 0xdb, 0x8e, 0x09],
    );
    const ITEM: Guid = Guid(
        0x43826d1e,
        0xe718,
        0x42ee,
        [0xbc, 0x55, 0xa1, 0xe2, 0x61, 0xc3, 0x7b, 0xfe],
    );
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoInitializeEx(reserved: Ptr, flags: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(memory: Ptr);
        fn CoCreateInstance(
            class: *const Guid,
            outer: Ptr,
            context: u32,
            iid: *const Guid,
            result: *mut Ptr,
        ) -> i32;
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHCreateItemFromParsingName(
            path: *const u16,
            bind: Ptr,
            iid: *const Guid,
            result: *mut Ptr,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }

    #[repr(C)]
    struct UnknownVtable {
        query: unsafe extern "system" fn(Ptr, *const Guid, *mut Ptr) -> i32,
        add: unsafe extern "system" fn(Ptr) -> u32,
        release: unsafe extern "system" fn(Ptr) -> u32,
    }
    #[repr(C)]
    struct ItemVtable {
        base: UnknownVtable,
        bind: usize,
        parent: usize,
        display_name: unsafe extern "system" fn(Ptr, u32, *mut *mut u16) -> i32,
    }
    unsafe fn shell_item_path(item: Ptr) -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        if item.is_null() {
            return None;
        }
        unsafe {
            let api = &**(item as *const *const ItemVtable);
            let mut name = ptr::null_mut();
            // SIGDN_FILESYSPATH; the Shell owns the item, this call owns name.
            if (api.display_name)(item, 0x80058000, &mut name) < 0 || name.is_null() {
                return None;
            }
            let mut length = 0;
            while *name.add(length) != 0 {
                length += 1;
            }
            let path = std::path::PathBuf::from(std::ffi::OsString::from_wide(
                std::slice::from_raw_parts(name, length),
            ));
            CoTaskMemFree(name.cast());
            path.is_absolute().then_some(path)
        }
    }

    #[repr(C)]
    struct OperationVtable {
        base: UnknownVtable,
        advise: usize,
        unadvise: usize,
        flags: unsafe extern "system" fn(Ptr, u32) -> i32,
        // SetProgressMessage through CopyItems, in the SDK's ABI order.
        unused: [usize; 12],
        delete: unsafe extern "system" fn(Ptr, Ptr, Ptr) -> i32,
        delete_items: usize,
        new_item: usize,
        perform: unsafe extern "system" fn(Ptr) -> i32,
        aborted: unsafe extern "system" fn(Ptr, *mut i32) -> i32,
    }
    struct Com(Ptr);
    impl Drop for Com {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // Owned interface reference, released before COM apartment exit.
                unsafe {
                    ((**(self.0 as *const *const UnknownVtable)).release)(self.0);
                }
            }
        }
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    #[repr(C)]
    struct Sink {
        vtable: *const SinkVtable,
        refs: AtomicU32,
        progress: Mutex<Progress>,
    }
    unsafe extern "system" fn query(this: Ptr, iid: *const Guid, out: *mut Ptr) -> i32 {
        if out.is_null() || iid.is_null() {
            return 0x80004003u32 as i32;
        }
        unsafe {
            *out = ptr::null_mut();
            if *iid == UNKNOWN || *iid == SINK {
                *out = this;
                add(this);
                0
            } else {
                0x80004002u32 as i32
            }
        }
    }
    unsafe extern "system" fn add(this: Ptr) -> u32 {
        unsafe { (*(this as *mut Sink)).refs.fetch_add(1, Ordering::Relaxed) + 1 }
    }
    unsafe extern "system" fn release(this: Ptr) -> u32 {
        let count = unsafe { (*(this as *mut Sink)).refs.fetch_sub(1, Ordering::AcqRel) - 1 };
        if count == 0 {
            unsafe {
                drop(Box::from_raw(this as *mut Sink));
            }
        }
        count
    }
    unsafe extern "system" fn pre_delete(this: Ptr, flags: u32, _: Ptr) -> i32 {
        unsafe {
            (*(this as *mut Sink))
                .progress
                .lock()
                .map(|mut p| p.pre_delete(flags))
                .unwrap_or(ABORT)
        }
    }
    unsafe extern "system" fn post_delete(
        this: Ptr,
        _: u32,
        _: Ptr,
        result: i32,
        item: Ptr,
    ) -> i32 {
        unsafe {
            match (*(this as *mut Sink)).progress.lock() {
                Ok(mut p) => {
                    p.post_delete(result, !item.is_null());
                    if result >= 0 {
                        p.trash_path = shell_item_path(item);
                    }
                    0
                }
                Err(_) => ABORT,
            }
        }
    }

    #[repr(C)]
    struct SinkVtable {
        base: UnknownVtable,
        start: unsafe extern "system" fn(Ptr) -> i32,
        finish: unsafe extern "system" fn(Ptr, i32) -> i32,
        pre_rename: unsafe extern "system" fn(Ptr, u32, Ptr, *const u16) -> i32,
        post_rename: unsafe extern "system" fn(Ptr, u32, Ptr, *const u16, i32, Ptr) -> i32,
        pre_move: unsafe extern "system" fn(Ptr, u32, Ptr, Ptr, *const u16) -> i32,
        post_move: unsafe extern "system" fn(Ptr, u32, Ptr, Ptr, *const u16, i32, Ptr) -> i32,
        pre_copy: unsafe extern "system" fn(Ptr, u32, Ptr, Ptr, *const u16) -> i32,
        post_copy: unsafe extern "system" fn(Ptr, u32, Ptr, Ptr, *const u16, i32, Ptr) -> i32,
        pre_delete: unsafe extern "system" fn(Ptr, u32, Ptr) -> i32,
        post_delete: unsafe extern "system" fn(Ptr, u32, Ptr, i32, Ptr) -> i32,
        pre_new: unsafe extern "system" fn(Ptr, u32, Ptr, *const u16) -> i32,
        post_new:
            unsafe extern "system" fn(Ptr, u32, Ptr, *const u16, *const u16, u32, i32, Ptr) -> i32,
        update: unsafe extern "system" fn(Ptr, u32, u32) -> i32,
        reset: unsafe extern "system" fn(Ptr) -> i32,
        pause: unsafe extern "system" fn(Ptr) -> i32,
        resume: unsafe extern "system" fn(Ptr) -> i32,
    }
    unsafe extern "system" fn start(_: Ptr) -> i32 {
        0
    }
    unsafe extern "system" fn finish(_: Ptr, _: i32) -> i32 {
        0
    }
    unsafe extern "system" fn pre_rename(_: Ptr, _: u32, _: Ptr, _: *const u16) -> i32 {
        ABORT
    }
    unsafe extern "system" fn post_rename(
        _: Ptr,
        _: u32,
        _: Ptr,
        _: *const u16,
        _: i32,
        _: Ptr,
    ) -> i32 {
        0
    }
    unsafe extern "system" fn pre_move(_: Ptr, _: u32, _: Ptr, _: Ptr, _: *const u16) -> i32 {
        ABORT
    }
    unsafe extern "system" fn post_move(
        _: Ptr,
        _: u32,
        _: Ptr,
        _: Ptr,
        _: *const u16,
        _: i32,
        _: Ptr,
    ) -> i32 {
        0
    }
    unsafe extern "system" fn pre_copy(_: Ptr, _: u32, _: Ptr, _: Ptr, _: *const u16) -> i32 {
        ABORT
    }
    unsafe extern "system" fn post_copy(
        _: Ptr,
        _: u32,
        _: Ptr,
        _: Ptr,
        _: *const u16,
        _: i32,
        _: Ptr,
    ) -> i32 {
        0
    }
    unsafe extern "system" fn pre_new(_: Ptr, _: u32, _: Ptr, _: *const u16) -> i32 {
        ABORT
    }
    unsafe extern "system" fn post_new(
        _: Ptr,
        _: u32,
        _: Ptr,
        _: *const u16,
        _: *const u16,
        _: u32,
        _: i32,
        _: Ptr,
    ) -> i32 {
        0
    }
    unsafe extern "system" fn update(_: Ptr, _: u32, _: u32) -> i32 {
        0
    }
    unsafe extern "system" fn reset(_: Ptr) -> i32 {
        0
    }
    unsafe extern "system" fn pause(_: Ptr) -> i32 {
        0
    }
    unsafe extern "system" fn resume(_: Ptr) -> i32 {
        0
    }
    static VTABLE: SinkVtable = SinkVtable {
        base: UnknownVtable {
            query,
            add,
            release,
        },
        start,
        finish,
        pre_rename,
        post_rename,
        pre_move,
        post_move,
        pre_copy,
        post_copy,
        pre_delete,
        post_delete,
        pre_new,
        post_new,
        update,
        reset,
        pause,
        resume,
    };

    pub(super) fn discard(path: &Path) -> (Outcome, Option<std::path::PathBuf>) {
        // Own STA thread: no dependency on Tauri's worker apartment mode.
        let path = path.to_path_buf();
        std::thread::spawn(move || run(&path))
            .join()
            .unwrap_or((Outcome::Uncertain, None))
    }
    fn run(path: &Path) -> (Outcome, Option<std::path::PathBuf>) {
        let Some(std::path::Component::Prefix(prefix)) = path.components().next() else {
            return (Outcome::Uncertain, None);
        };
        let root: Vec<u16> = prefix
            .as_os_str()
            .encode_wide()
            .chain([b'\\' as u16, 0])
            .collect();
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if wide[..wide.len() - 1].contains(&0) {
            return (Outcome::Failed, None);
        }
        // All interface calls use SDK layouts and owned references. The sink's
        // initial reference outlives operation destruction and all callbacks.
        unsafe {
            if GetDriveTypeW(root.as_ptr()) == 4 {
                return (Outcome::UnavailableForTarget, None);
            }
            if CoInitializeEx(ptr::null_mut(), 2 | 4) < 0 {
                return (Outcome::Uncertain, None);
            }
            let _apartment = Apartment;
            let mut item = Com(ptr::null_mut());
            if SHCreateItemFromParsingName(wide.as_ptr(), ptr::null_mut(), &ITEM, &mut item.0) < 0 {
                return (Outcome::Uncertain, None);
            }
            let sink = Com(Box::into_raw(Box::new(Sink {
                vtable: &VTABLE,
                refs: AtomicU32::new(1),
                progress: Mutex::new(Progress::default()),
            }))
            .cast());
            let mut operation = Com(ptr::null_mut());
            if CoCreateInstance(&CLASS, ptr::null_mut(), 1, &OPERATION, &mut operation.0) < 0 {
                return (Outcome::Uncertain, None);
            }
            let api = &**(operation.0 as *const *const OperationVtable);
            // RECYCLEONDELETE, ADDUNDORECORD, EARLYFAILURE, NOERRORUI,
            // NO_CONNECTED_ELEMENTS, SILENT. No native nuke confirmation UI.
            if (api.flags)(
                operation.0,
                0x00080000 | 0x20000000 | 0x00100000 | 0x0400 | 0x2000 | 0x0004,
            ) < 0
                || (api.delete)(operation.0, item.0, sink.0) < 0
            {
                return (Outcome::Uncertain, None);
            }
            let result = (api.perform)(operation.0);
            let mut aborted = 1;
            if (api.aborted)(operation.0, &mut aborted) < 0 {
                return (Outcome::Uncertain, None);
            }
            let present = match std::fs::symlink_metadata(path) {
                Ok(_) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(_) => return (Outcome::Uncertain, None),
            };
            let outcome = (*(sink.0 as *mut Sink))
                .progress
                .lock()
                .map(|p| {
                    (
                        p.outcome(result, aborted != 0, present),
                        p.trash_path.clone(),
                    )
                })
                .unwrap_or((Outcome::Uncertain, None));
            outcome
        }
    }

    #[cfg(test)]
    mod receipt_tests {
        use super::*;
        #[link(name = "ole32")]
        unsafe extern "system" {
            fn CoTaskMemAlloc(size: usize) -> Ptr;
        }

        unsafe extern "system" fn name(_: Ptr, kind: u32, out: *mut *mut u16) -> i32 {
            if kind != 0x80058000 {
                return ABORT;
            }
            let value: Vec<u16> = "C:\\$Recycle.Bin\\user\\$RStory.ZIP"
                .encode_utf16()
                .chain([0])
                .collect();
            unsafe {
                let memory = CoTaskMemAlloc(value.len() * 2).cast::<u16>();
                if memory.is_null() {
                    return ABORT;
                }
                ptr::copy_nonoverlapping(value.as_ptr(), memory, value.len());
                *out = memory;
            }
            0
        }
        unsafe extern "system" fn unavailable(_: Ptr, _: u32, _: *mut *mut u16) -> i32 {
            ABORT
        }

        #[test]
        fn windows_post_delete_copies_the_recycled_item_path_and_handles_missing_paths() {
            for (display_name, expected) in [
                (
                    name as unsafe extern "system" fn(Ptr, u32, *mut *mut u16) -> i32,
                    true,
                ),
                (unavailable, false),
            ] {
                let api = ItemVtable {
                    base: UnknownVtable {
                        query,
                        add,
                        release,
                    },
                    bind: 0,
                    parent: 0,
                    display_name,
                };
                let mut item = &api as *const ItemVtable;
                let sink = Com(Box::into_raw(Box::new(Sink {
                    vtable: &VTABLE,
                    refs: AtomicU32::new(1),
                    progress: Mutex::new(Progress::default()),
                }))
                .cast());
                unsafe {
                    assert_eq!(
                        post_delete(
                            sink.0,
                            RECYCLE,
                            ptr::null_mut(),
                            0,
                            (&mut item as *mut *const ItemVtable).cast()
                        ),
                        0
                    );
                    let state = (*(sink.0 as *mut Sink)).progress.lock().unwrap();
                    assert_eq!(state.trash_path.is_some(), expected);
                    if expected {
                        assert_eq!(
                            state.trash_path.as_deref(),
                            Some(Path::new("C:\\$Recycle.Bin\\user\\$RStory.ZIP"))
                        );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trash_windows_disabled_bin_and_oversized_target_are_vetoed_before_mutation() {
        for native_error in [FORCE_NUKE, TOO_BIG] {
            let mut progress = Progress::default();
            let mut mutation_count = 0;
            if progress.pre_delete(0) >= 0 {
                mutation_count += 1;
            }
            assert_eq!(
                mutation_count, 0,
                "Shell's permanent-delete callback must be refused"
            );
            assert_eq!(
                progress.outcome(native_error, true, true),
                Outcome::UnavailableForTarget
            );
        }
    }
    #[test]
    fn trash_windows_recycling_requires_native_receipt_and_source_disappearance() {
        let mut p = Progress::default();
        assert_eq!(p.pre_delete(RECYCLE), 0);
        p.post_delete(0, true);
        assert_eq!(p.outcome(0, false, false), Outcome::Removed);
        assert_eq!(p.outcome(0, false, true), Outcome::Uncertain);
        assert_eq!(p.outcome(0, true, false), Outcome::Uncertain);
    }
    #[test]
    fn trash_windows_structured_errors_do_not_turn_permissions_or_ambiguity_into_unavailability() {
        for (code, expected) in [
            (FORCE_NUKE, Outcome::UnavailableForTarget),
            (TOO_BIG, Outcome::UnavailableForTarget),
            (BIN_MISSING, Outcome::UnavailableForTarget),
            (0x80070005u32 as i32, Outcome::Failed),
            (ABORT, Outcome::Uncertain),
        ] {
            let mut p = Progress::default();
            p.pre_delete(RECYCLE);
            p.post_delete(code, false);
            assert_eq!(p.outcome(code, true, true), expected);
            assert_eq!(p.outcome(code, true, false), Outcome::Uncertain);
        }
        let mut p = Progress::default();
        p.pre_delete(RECYCLE);
        p.post_delete(0, false);
        assert_eq!(p.outcome(0, false, false), Outcome::Uncertain);
        // A later veto after an attempted mutation cannot establish absence of
        // effects, even if a directory's top-level path remains present.
        p.pre_delete(0);
        assert_eq!(p.outcome(ABORT, true, true), Outcome::Uncertain);
    }
}
