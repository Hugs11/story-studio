//! Optional, silent stable-release notice. No updater and no frontend network access.
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};

const ENDPOINT: &str = "https://api.github.com/repos/Hugs11/story-studio/releases/latest";
const RELEASE_PREFIX: &str = "https://github.com/Hugs11/story-studio/releases/";

#[derive(Debug, PartialEq, Serialize)]
pub struct ReleaseNotice {
    version: String,
    url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
}

fn version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.strip_prefix('v').unwrap_or(value).split('.');
    let mut result = [0; 3];
    for part in &mut result {
        let digits = parts.next()?;
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        *part = digits.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

fn parse_release(status: u16, body: &[u8], installed: &str) -> Option<ReleaseNotice> {
    if status != 200 {
        return None;
    }
    let release: Release = serde_json::from_slice(body).ok()?;
    if release.draft || release.prerelease || version(&release.tag_name)? <= version(installed)? {
        return None;
    }
    let url = reqwest::Url::parse(&release.html_url).ok()?;
    if !release.html_url.starts_with(RELEASE_PREFIX)
        || !url.path().starts_with("/Hugs11/story-studio/releases/")
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    Some(ReleaseNotice {
        version: release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name)
            .to_owned(),
        url: release.html_url,
    })
}

async fn check_with<F, Fut>(enabled: bool, installed: &str, fetch: F) -> Option<ReleaseNotice>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<(u16, Vec<u8>)>>,
{
    if !enabled {
        return None;
    }
    let (status, body) = fetch().await?;
    parse_release(status, &body, installed)
}

#[tauri::command]
pub async fn check_stable_release(enabled: bool) -> Option<ReleaseNotice> {
    check_with(enabled, env!("CARGO_PKG_VERSION"), || async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Story-Studio/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok()?;
        let response = client.get(ENDPOINT).send().await.ok()?;
        let status = response.status().as_u16();
        if status != 200 {
            return None;
        }
        // Bound even an unexpected response; the timeout covers body streaming too.
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if body.len() + chunk.len() > 256 * 1024 {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        Some((status, body))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body(tag: &str, draft: bool, prerelease: bool) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "tag_name": tag, "html_url": format!("{RELEASE_PREFIX}tag/{tag}"),
            "draft": draft, "prerelease": prerelease
        }))
        .unwrap()
    }
    #[test]
    fn numeric_versions_and_prefix() {
        let versions = ["0.9.10", "0.9.11", "0.10.0", "1.0.0"];
        for pair in versions.windows(2) {
            assert!(version(pair[0]) < version(pair[1]));
            assert!(parse_release(200, &body(pair[1], false, false), pair[0]).is_some());
        }
        assert_eq!(version("v0.9.11"), version("0.9.11"));
        let notice = parse_release(200, &body("v0.9.11", false, false), "0.9.10").unwrap();
        assert_eq!(notice.version, "0.9.11");
        assert!(parse_release(200, &body("0.9.10", false, false), "0.9.10").is_none());
        assert!(parse_release(200, &body("0.9.9", false, false), "0.9.10").is_none());
    }
    #[test]
    fn ignores_unstable_drafts_invalid_json_and_http_errors() {
        for (tag, draft, pre) in [
            ("1.0.0", true, false),
            ("1.0.0", false, true),
            ("1.0.0-rc.1", false, false),
            ("1.0", false, false),
        ] {
            assert!(parse_release(200, &body(tag, draft, pre), "0.9.10").is_none());
        }
        assert!(parse_release(200, b"invalid", "0.9.10").is_none());
        for status in [403, 404, 500] {
            assert!(parse_release(status, &body("1.0.0", false, false), "0.9.10").is_none());
        }
        let mut json: serde_json::Value =
            serde_json::from_slice(&body("1.0.0", false, false)).unwrap();
        json["html_url"] = "https://github.com.evil/Hugs11/story-studio/releases/tag/1.0.0".into();
        assert!(parse_release(200, &serde_json::to_vec(&json).unwrap(), "0.9.10").is_none());
    }
    #[test]
    fn disabled_never_calls_transport_and_failures_are_silent() {
        tauri::async_runtime::block_on(async {
            assert!(
                check_with(false, "0.9.10", || async { panic!("unexpected request") })
                    .await
                    .is_none()
            );
            assert!(check_with(true, "0.9.10", || async { None })
                .await
                .is_none());
            assert!(check_with(true, "0.9.10", || async {
                Some((403, body("1.0.0", false, false)))
            })
            .await
            .is_none());
            assert!(check_with(true, "0.9.10", || async {
                Some((200, b"invalid".to_vec()))
            })
            .await
            .is_none());
        });
    }
}
