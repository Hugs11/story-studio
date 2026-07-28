use std::ffi::{c_void, CStr};
use std::ptr;

use glib::prelude::*;
use glib::translate::{from_glib_none, IntoGlib, IntoGlibPtr};
use gtk::prelude::*;
use tauri::WebviewWindow;

const WEBKIT_ZOOM_GESTURE_KEY: &CStr = c"wk-view-zoom-gesture";
const BEGIN_SIGNAL: &CStr = c"begin";
const SCALE_CHANGED_SIGNAL: &CStr = c"scale-changed";
const END_SIGNAL: &CStr = c"end";

fn block_existing_handlers(gesture: &gtk::GestureZoom, signal: &CStr) -> u32 {
    unsafe {
        let signal_id = glib::gobject_ffi::g_signal_lookup(
            signal.as_ptr(),
            gesture.type_().into_glib(),
        );
        if signal_id == 0 {
            return 0;
        }
        glib::gobject_ffi::g_signal_handlers_block_matched(
            gesture.as_ptr() as *mut glib::gobject_ffi::GObject,
            glib::gobject_ffi::G_SIGNAL_MATCH_ID,
            signal_id,
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    }
}

unsafe extern "C" fn unref_gobject(data: *mut c_void) {
    glib::gobject_ffi::g_object_unref(data.cast::<glib::gobject_ffi::GObject>());
}

fn dispatch_pinch(
    window: &WebviewWindow,
    phase: &str,
    scale: f64,
    center: Option<(f64, f64)>,
) {
    let (x, y) = center.unwrap_or((-1.0, -1.0));
    if !scale.is_finite() || !x.is_finite() || !y.is_finite() {
        return;
    }
    let script = format!(
        "window.dispatchEvent(new CustomEvent('story-studio:native-pinch',\
         {{detail:{{phase:'{phase}',scale:{scale},clientX:{x},clientY:{y}}}}}));"
    );
    if let Err(error) = window.eval(script) {
        log::warn!(target: "diagram", "Linux pinch event could not reach the diagram: {error}");
    }
}

/// WebKitGTK consumes touchpad pinch gestures in its native UI process before
/// the page can cancel them. Its GTK3 zoom recognizer is private, but exposed
/// on the WebView widget as `wk-view-zoom-gesture`. We keep that recognizer so
/// GTK/libinput remains the source of gesture data, block only WebKit's page
/// magnification callbacks, then forward the normalized gesture to the shared
/// diagram viewport.
pub(crate) fn install_diagram_pinch_bridge(
    window: WebviewWindow,
    platform_webview: tauri::webview::PlatformWebview,
) -> Result<(), String> {
    let webview = platform_webview.inner();
    let gesture_ptr = unsafe {
        glib::gobject_ffi::g_object_get_data(
            webview.as_ptr() as *mut glib::gobject_ffi::GObject,
            WEBKIT_ZOOM_GESTURE_KEY.as_ptr(),
        )
    };
    if gesture_ptr.is_null() {
        return Err("WebKitGTK zoom gesture is unavailable".to_string());
    }

    let gesture: gtk::GestureZoom =
        unsafe { from_glib_none(gesture_ptr.cast::<gtk::ffi::GtkGestureZoom>()) };
    let blocked = [
        block_existing_handlers(&gesture, BEGIN_SIGNAL),
        block_existing_handlers(&gesture, SCALE_CHANGED_SIGNAL),
        block_existing_handlers(&gesture, END_SIGNAL),
    ];
    if blocked.contains(&0) {
        return Err(format!(
            "WebKitGTK zoom callbacks were not all found ({blocked:?})"
        ));
    }

    let begin_window = window.clone();
    gesture.connect_begin(move |gesture, _| {
        dispatch_pinch(
            &begin_window,
            "begin",
            1.0,
            gesture.bounding_box_center(),
        );
    });

    let change_window = window.clone();
    gesture.connect_scale_changed(move |gesture, scale| {
        dispatch_pinch(
            &change_window,
            "change",
            scale,
            gesture.bounding_box_center(),
        );
    });

    gesture.connect_end(move |gesture, _| {
        dispatch_pinch(&window, "end", 1.0, gesture.bounding_box_center());
    });

    // Retain our Rust closures for exactly as long as WebKit retains its
    // recognizer. GTK owns the underlying object through the WebView widget.
    unsafe {
        let retained_gesture: *mut gtk::ffi::GtkGestureZoom = gesture.into_glib_ptr();
        glib::gobject_ffi::g_object_set_data_full(
            webview.as_ptr() as *mut glib::gobject_ffi::GObject,
            c"story-studio-diagram-pinch-bridge".as_ptr(),
            retained_gesture.cast::<c_void>(),
            Some(unref_gobject),
        );
    }

    Ok(())
}
