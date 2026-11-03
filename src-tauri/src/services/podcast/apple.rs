//! Résout les liens de partage Apple Podcasts avant la lecture RSS commune.
use super::{read_limited, validate_remote_url, FEED_TIMEOUT, USER_AGENT};
use crate::support::user_message::{codes, UserMessage};
use reqwest::{blocking::Client, Url};
use serde::Deserialize;

const LOOKUP_URL: &str = "https://itunes.apple.com/lookup";
const MAX_LOOKUP_BYTES: u64 = 1024 * 1024;

fn failure(code: &'static str, detail: impl ToString) -> String {
    UserMessage::new(code)
        .with_detail(detail.to_string())
        .into_transport()
}

/// Hôtes exacts uniquement : un flux tiers reste une URL RSS ordinaire.
fn lookup_url(source: &Url) -> Result<Option<Url>, String> {
    if !matches!(
        source.host_str(),
        Some("podcasts.apple.com" | "itunes.apple.com")
    ) {
        return Ok(None);
    }
    let segments: Vec<_> = source
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
    let id = segments
        .last()
        .and_then(|s| s.strip_prefix("id"))
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|id| *id > 0);
    let Some(id) = id.filter(|_| segments.contains(&"podcast")) else {
        return Err(failure(
            codes::PODCAST_APPLE_INVALID_LINK,
            "Apple Podcasts URL has no podcast collection ID",
        ));
    };
    let mut lookup = Url::parse(LOOKUP_URL).expect("constant Apple lookup URL");
    lookup
        .query_pairs_mut()
        .append_pair("id", &id.to_string())
        .append_pair("entity", "podcast");
    if let Some(country) = segments
        .first()
        .filter(|s| s.len() == 2 && s.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        lookup.query_pairs_mut().append_pair("country", country);
    }
    Ok(Some(lookup))
}

#[derive(Deserialize)]
struct Lookup {
    results: Vec<Podcast>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Podcast {
    collection_id: Option<u64>,
    kind: Option<String>,
    feed_url: Option<String>,
}

fn parse_lookup(bytes: &[u8], id: u64) -> Result<Url, String> {
    let lookup: Lookup = serde_json::from_slice(bytes)
        .map_err(|e| failure(codes::PODCAST_APPLE_LOOKUP_FAILED, e))?;
    let feed = lookup
        .results
        .into_iter()
        .find(|p| p.collection_id == Some(id) && p.kind.as_deref() == Some("podcast"))
        .and_then(|p| p.feed_url)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            failure(
                codes::PODCAST_APPLE_FEED_MISSING,
                "Apple returned no public RSS feed for this podcast",
            )
        })?;
    validate_remote_url(&feed).map_err(|e| failure(codes::PODCAST_APPLE_LOOKUP_FAILED, e))
}

fn fetch_lookup(client: &Client, lookup: Url, id: u64) -> Result<Url, String> {
    let response = client
        .get(lookup)
        .timeout(FEED_TIMEOUT)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| failure(codes::PODCAST_APPLE_LOOKUP_FAILED, e))?;
    let bytes = read_limited(response, MAX_LOOKUP_BYTES)
        .map_err(|e| failure(codes::PODCAST_APPLE_LOOKUP_FAILED, e))?;
    parse_lookup(&bytes, id)
}

pub(super) fn resolve_feed_url(client: &Client, source: Url) -> Result<Url, String> {
    let Some(lookup) = lookup_url(&source)? else {
        return Ok(source);
    };
    let id = lookup
        .query_pairs()
        .find(|(k, _)| k == "id")
        .expect("lookup ID")
        .1
        .parse()
        .expect("numeric lookup ID");
    fetch_lookup(client, lookup, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Apple Podcasts and the publisher RSS service"]
    fn live_apple_link_loads_rodolphe_feed() {
        let feed = super::super::fetch_feed("https://podcasts.apple.com/fr/podcast/les-aventures-de-rodolphe-et-gala-histoires-pour-enfants/id1509423716").unwrap();
        assert!(feed.title.contains("Rodolphe"));
        assert!(!feed.episodes.is_empty());
        assert!(feed
            .episodes
            .iter()
            .all(|episode| episode.audio_url.starts_with("https://")));
    }

    #[test]
    fn recognizes_share_links_and_uses_collection_not_episode_id() {
        for source in [
            "https://podcasts.apple.com/fr/podcast/rodolphe/id1509423716?i=999&uo=4",
            "https://podcasts.apple.com/fr/podcast/id1509423716/",
            "https://itunes.apple.com/fr/podcast/name/id1509423716?mt=2",
            "https://podcasts.apple.com/podcast/id1509423716",
        ] {
            let lookup = lookup_url(&Url::parse(source).unwrap()).unwrap().unwrap();
            assert_eq!(lookup.host_str(), Some("itunes.apple.com"));
            assert!(lookup
                .query_pairs()
                .any(|(k, v)| k == "id" && v == "1509423716"));
            assert!(!lookup.query_pairs().any(|(k, _)| k == "i"));
            assert_eq!(
                lookup
                    .query_pairs()
                    .any(|(k, v)| k == "country" && v == "fr"),
                source.contains("/fr/")
            );
        }
    }

    #[test]
    fn leaves_rss_urls_unchanged_and_rejects_invalid_apple_links() {
        for source in [
            "https://feeds.example/Show.XML?key=AbC",
            "https://podcasts.apple.com.example/podcast/id123",
        ] {
            let url = Url::parse(source).unwrap();
            assert_eq!(resolve_feed_url(&Client::new(), url.clone()).unwrap(), url);
        }
        for path in [
            "/fr/podcast/name",
            "/fr/podcast/idabc",
            "/fr/podcast/id0",
            "/fr/artist/id123",
            "/podcast/id18446744073709551616",
        ] {
            assert!(
                lookup_url(&Url::parse(&format!("https://podcasts.apple.com{path}")).unwrap())
                    .unwrap_err()
                    .contains("PODCAST_APPLE_INVALID_LINK")
            );
        }
    }

    #[test]
    fn validates_lookup_results_and_feed_scheme() {
        let bytes = br#"{"results":[{"collectionId":42,"kind":"podcast","feedUrl":"https://example.com/Show.xml?key=AbC"}]}"#;
        assert_eq!(
            parse_lookup(bytes, 42).unwrap().as_str(),
            "https://example.com/Show.xml?key=AbC"
        );
        for bytes in [
            br#"{"results":[]}"#.as_slice(),
            br#"{"results":[{"collectionId":42,"kind":"podcast"}]}"#,
            br#"{"results":[{"collectionId":42,"kind":"podcast","feedUrl":" "}]}"#,
        ] {
            assert!(parse_lookup(bytes, 42)
                .unwrap_err()
                .contains("PODCAST_APPLE_FEED_MISSING"));
        }
        assert!(parse_lookup(bytes, 99)
            .unwrap_err()
            .contains("PODCAST_APPLE_FEED_MISSING"));
        for bytes in [
            b"<html>unavailable</html>".as_slice(),
            br#"{"results":[{"collectionId":42,"kind":"podcast","feedUrl":"file:///tmp/feed"}]}"#,
        ] {
            assert!(parse_lookup(bytes, 42)
                .unwrap_err()
                .contains("PODCAST_APPLE_LOOKUP_FAILED"));
        }
    }

    #[test]
    fn lookup_http_success_and_failures() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"results":[{"collectionId":42,"kind":"podcast","feedUrl":"https://example.com/feed"}]}"#,
                None,
            ),
            (
                "503 Service Unavailable",
                "unavailable",
                Some("PODCAST_APPLE_LOOKUP_FAILED"),
            ),
            (
                "200 OK",
                "invalid json",
                Some("PODCAST_APPLE_LOOKUP_FAILED"),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!(
                "http://{}/lookup?id=42&entity=podcast",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let size = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..size])
                    .contains("GET /lookup?id=42&entity=podcast"));
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let result = fetch_lookup(&Client::builder().no_proxy().build().unwrap(), url, 42);
            server.join().unwrap();
            match expected {
                Some(code) => assert!(result.unwrap_err().contains(code)),
                None => assert_eq!(result.unwrap().as_str(), "https://example.com/feed"),
            }
        }
    }
}
