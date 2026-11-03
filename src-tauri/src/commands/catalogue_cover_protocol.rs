//! `catalogue-cover` protocol: the catalogue grid reads each fiche cover by a
//! stable address usable directly in `<img src>`.
//!
//! Address: `/v1/<percent-encoded fiche id>/<coverSignature>.jpg` (`v1`:
//! encoder version, `cover_store::ENCODER`) on the scheme
//! origin (`catalogue-cover://localhost` on Linux/macOS,
//! `http://catalogue-cover.localhost` on Windows, chosen by Tauri; the
//! interface builds it in `src/store/catalogue/coverAddress.js`). The query
//! string is ignored, so the interface may add one to force a new attempt.
//!
//! A custom protocol rather than the `asset` protocol: an address names a
//! fiche and a signature, never a path; the signature is checked against the
//! catalogue before anything is made; a missing image is made on demand, off
//! the main thread; failures answer distinct statuses. Every request runs on
//! the blocking pool.
use crate::services::catalogue::{self, cover_store::Served};
use tauri::http::{header, Method, Response, StatusCode};

pub const SCHEME: &str = "catalogue-cover";
/// Response header carrying the outcome name (`Served::state`), readable by
/// `fetch` from the interface origin.
pub const STATE_HEADER: &str = "x-cover-state";

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |context, request, responder| {
        let app = context.app_handle().clone();
        let method = request.method().clone();
        let path = request.uri().path().to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            responder.respond(answer(&method, &path, |id, signature| {
                catalogue::open_store(&app)?.served_cover(id, signature)
            }));
        });
    })
}

fn answer(
    method: &Method,
    path: &str,
    serve: impl FnOnce(&str, &str) -> catalogue::Result<Served>,
) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED, "method");
    }
    let served = match catalogue::cover_store::parse_address(path) {
        None => Served::BadAddress,
        Some((id, signature)) => match serve(&id, &signature) {
            Ok(served) => served,
            Err(reason) => {
                log::warn!("Catalogue cover address: {}", reason.code);
                return empty(StatusCode::INTERNAL_SERVER_ERROR, "error");
            }
        },
    };
    let head = method == Method::HEAD;
    let status = status(&served);
    let state = served.state();
    match served {
        Served::Ready(bytes) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CONTENT_LENGTH, bytes.len())
            // The signature is in the address: its bytes never change.
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, STATE_HEADER)
            .header(STATE_HEADER, state)
            .body(if head { Vec::new() } else { bytes })
            .unwrap_or_else(|_| Response::new(Vec::new())),
        _ => empty(status, state),
    }
}

/// One status per outcome the interface treats differently.
pub fn status(served: &Served) -> StatusCode {
    match served {
        Served::Ready(_) => StatusCode::OK,
        Served::Absent => StatusCode::NO_CONTENT,
        Served::BadAddress => StatusCode::BAD_REQUEST,
        Served::UnknownFiche => StatusCode::NOT_FOUND,
        Served::Stale => StatusCode::GONE,
        Served::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        Served::Unreadable => StatusCode::UNPROCESSABLE_ENTITY,
        Served::Busy | Served::Offline => StatusCode::SERVICE_UNAVAILABLE,
    }
}

fn empty(status: StatusCode, state: &str) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(status)
        // A failure may change at any time: never cached.
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, STATE_HEADER)
        .header(STATE_HEADER, state);
    if status == StatusCode::SERVICE_UNAVAILABLE && state == "busy" {
        response = response.header(header::RETRY_AFTER, "1");
    }
    response
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig() -> String {
        "0123456789abcdef".repeat(4)
    }

    #[test]
    fn ready_answers_an_immutable_jpeg() {
        let response = answer(&Method::GET, &format!("/v1/card/{}.jpg", sig()), |id, s| {
            assert_eq!((id, s), ("card", sig().as_str()));
            Ok(Served::Ready(vec![0xff, 0xd8, 0xff]))
        });
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(response.headers()[STATE_HEADER], "ready");
        assert_eq!(response.body(), &vec![0xff, 0xd8, 0xff]);
        let head = answer(&Method::HEAD, &format!("/v1/card/{}.jpg", sig()), |_, _| {
            Ok(Served::Ready(vec![1, 2, 3]))
        });
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
    }

    #[test]
    fn every_failure_has_its_own_uncached_status() {
        let cases = [
            (Served::Absent, 204, "absent"),
            (Served::UnknownFiche, 404, "unknownFiche"),
            (Served::Stale, 410, "stale"),
            (Served::TooLarge, 413, "tooLarge"),
            (Served::Unreadable, 422, "unreadable"),
            (Served::Busy, 503, "busy"),
            (Served::Offline, 503, "offline"),
        ];
        for (served, code, state) in cases {
            let response = answer(&Method::GET, &format!("/v1/card/{}.jpg", sig()), |_, _| {
                Ok(served)
            });
            assert_eq!(response.status().as_u16(), code, "{state}");
            assert_eq!(response.headers()[STATE_HEADER], state);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn forged_addresses_never_reach_the_store() {
        for path in [
            "/../../etc/passwd".to_owned(),
            format!("/v1/%2E%2E/{}.jpg", sig()),
            format!("/v1/card/{}.png", sig()),
            format!("/card/{}.jpg", sig()),
            "/v1/card/not-a-signature.jpg".to_owned(),
        ] {
            let response = answer(&Method::GET, &path, |_, _| panic!("{path}"));
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
            assert_eq!(response.headers()[STATE_HEADER], "badAddress");
        }
        let post = answer(&Method::POST, &format!("/v1/card/{}.jpg", sig()), |_, _| {
            panic!("method")
        });
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
