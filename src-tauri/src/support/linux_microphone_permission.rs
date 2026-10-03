use glib::prelude::*;
use tauri::Url;
use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequestExt, WebViewExt};

fn same_page_origin(trusted: &Url, requested: &str) -> bool {
    let Ok(requested) = Url::parse(requested) else {
        return false;
    };
    trusted.host_str().is_some()
        && requested.scheme() == trusted.scheme()
        && requested.host_str() == trusted.host_str()
        && requested.port_or_known_default() == trusted.port_or_known_default()
}

/// WebKitGTK denies permission requests when the embedding application does
/// not handle them. Only the local Story Studio page may capture audio; this
/// handler does not grant video or any other WebKit permission.
pub(crate) fn install(platform_webview: tauri::webview::PlatformWebview, trusted_url: Url) {
    platform_webview
        .inner()
        .connect_permission_request(move |webview, request| {
            let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
            else {
                return false;
            };
            let trusted_page = webview
                .uri()
                .is_some_and(|uri| same_page_origin(&trusted_url, uri.as_str()));
            if trusted_page && media.is_for_audio_device() && !media.is_for_video_device() {
                request.allow();
                return true;
            }
            false
        });
}

#[cfg(test)]
mod tests {
    use super::same_page_origin;
    use tauri::Url;

    #[test]
    fn only_the_application_origin_is_trusted() {
        let dev = Url::parse("http://127.0.0.1:1420/").unwrap();
        assert!(same_page_origin(&dev, "http://127.0.0.1:1420/editor"));
        assert!(!same_page_origin(&dev, "http://127.0.0.1:1421/"));
        assert!(!same_page_origin(&dev, "http://localhost:1420/"));
        assert!(!same_page_origin(&dev, "https://example.com/"));

        let bundled = Url::parse("tauri://localhost/").unwrap();
        assert!(same_page_origin(&bundled, "tauri://localhost/editor"));
        assert!(!same_page_origin(&bundled, "tauri://elsewhere/"));
        assert!(!same_page_origin(&bundled, "data:text/html,microphone"));
    }
}
