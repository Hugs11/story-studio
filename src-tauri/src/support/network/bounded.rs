//! Bounded official-service requests. Cancellation never waits on a socket.
use reqwest::blocking::Client;
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
#[derive(Debug, PartialEq)]
pub enum Failure {
    Offline,
    Timeout,
    TooLarge,
    Cancelled,
    Busy,
    Refused,
    /// The server answered with an HTTP error status (4xx or 5xx).
    Status,
}
static WORKERS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
pub(crate) static TEST_NETWORK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(test)]
pub(crate) fn test_network() -> std::sync::MutexGuard<'static, ()> {
    let guard = TEST_NETWORK.lock().unwrap_or_else(|e| e.into_inner());
    // Cancellation intentionally returns before a blocked HTTP worker. Wait
    // for that previous test's bounded worker before reserving a new fixture.
    let deadline = Instant::now() + Duration::from_secs(30);
    while WORKERS.load(Ordering::SeqCst) != 0 {
        assert!(
            Instant::now() < deadline,
            "previous HTTP test left workers running"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    guard
}
pub fn check(cancel: &AtomicBool, deadline: Instant) -> Result<(), Failure> {
    if cancel.load(Ordering::Relaxed) {
        Err(Failure::Cancelled)
    } else if Instant::now() >= deadline {
        Err(Failure::Timeout)
    } else {
        Ok(())
    }
}
pub fn get(
    url: &str,
    token: Option<&str>,
    max: usize,
    cancel: &AtomicBool,
    deadline: Instant,
    progress: impl Fn(usize),
) -> Result<Vec<u8>, Failure> {
    check(cancel, deadline)?;
    let parsed = reqwest::Url::parse(url).map_err(|_| Failure::Refused)?;
    let official = parsed.scheme() == "https"
        && matches!(
            parsed.host_str(),
            Some(
                "server-auth-prod.lunii.com"
                    | "server-data-prod.lunii.com"
                    | "storage.googleapis.com"
            )
        )
        && parsed.port().is_none();
    #[cfg(test)]
    let official =
        official || (parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1"));
    if !official || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Failure::Refused);
    }
    WORKERS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 2).then_some(n + 1)
        })
        .map_err(|_| Failure::Busy)?;
    let token = token.map(str::to_owned);
    let (tx, rx) = mpsc::sync_channel(2);
    let spawned = std::thread::Builder::new()
        .name("official-download".into())
        .spawn(move || {
            struct Permit;
            impl Drop for Permit {
                fn drop(&mut self) {
                    WORKERS.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let permit = Permit;
            let result = (|| {
                let client = Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(deadline.saturating_duration_since(Instant::now()))
                    .connect_timeout(Duration::from_secs(5))
                    .build()
                    .map_err(|_| Failure::Offline)?;
                let mut request = client
                    .get(parsed)
                    .header(reqwest::header::ACCEPT_ENCODING, "identity");
                if let Some(token) = token {
                    request = request.header("X-AUTH-TOKEN", token);
                }
                let mut response = request.send().map_err(|e| {
                    if e.is_timeout() {
                        Failure::Timeout
                    } else {
                        Failure::Offline
                    }
                })?;
                if response.status().is_client_error() || response.status().is_server_error() {
                    return Err(Failure::Status);
                }
                if !response.status().is_success() {
                    return Err(Failure::Offline);
                }
                if response.content_length().is_some_and(|n| n > max as u64) {
                    return Err(Failure::TooLarge);
                }
                let mut total = 0;
                loop {
                    let mut chunk = vec![0; 8192.min(max + 1 - total)];
                    let n = response.read(&mut chunk).map_err(|_| {
                        if Instant::now() >= deadline {
                            Failure::Timeout
                        } else {
                            Failure::Offline
                        }
                    })?;
                    if n == 0 {
                        break;
                    }
                    total += n;
                    if total > max {
                        return Err(Failure::TooLarge);
                    }
                    chunk.truncate(n);
                    if tx.send(Ok(Some(chunk))).is_err() {
                        return Ok(());
                    }
                }
                Ok(())
            })();
            drop(permit);
            let _ = tx.send(result.map(|()| None));
        });
    if spawned.is_err() {
        WORKERS.fetch_sub(1, Ordering::SeqCst);
        return Err(Failure::Offline);
    }
    let mut bytes = Vec::new();
    loop {
        check(cancel, deadline)?;
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(Some(chunk))) => {
                bytes.extend_from_slice(&chunk);
                progress(bytes.len());
            }
            Ok(Ok(None)) => {
                check(cancel, deadline)?;
                return Ok(bytes);
            }
            Ok(Err(e)) => return Err(e),
            Err(mpsc::RecvTimeoutError::Timeout) => progress(bytes.len()),
            Err(_) => return Err(Failure::Offline),
        }
    }
}
#[cfg(test)]
pub(crate) fn read_request(socket: &mut std::net::TcpStream) -> String {
    // Accepted sockets inherit a nonblocking listener's mode on Windows.
    // The test protocol reads a complete request with a bounded blocking read.
    socket.set_nonblocking(false).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 8192);
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    String::from_utf8(bytes).unwrap()
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, sync::Arc};
    #[test]
    fn bounded_size_timeout_cancellation_and_redirect_refusal() {
        let _network = test_network();
        let cancel = Arc::new(AtomicBool::new(false));
        for (response,limit,expected) in [
            ("HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\n",10,Failure::TooLarge),
            ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n0123456789012345",10,Failure::TooLarge),
            ("HTTP/1.1 302 Found\r\nLocation: https://server-data-prod.lunii.com/v2/packs\r\nContent-Length: 0\r\n\r\n",100,Failure::Offline),
        ] {
            let server=TcpListener::bind("127.0.0.1:0").unwrap();let addr=server.local_addr().unwrap();let server=std::thread::spawn(move ||{let(mut socket,_)=server.accept().unwrap();assert!(read_request(&mut socket).starts_with("GET "));socket.write_all(response.as_bytes()).unwrap();});
            assert_eq!(get(&format!("http://{addr}"),None,limit,&cancel,Instant::now()+Duration::from_secs(2),|_|{}),Err(expected));server.join().unwrap();
        }
        assert_eq!(
            get(
                "https://example.org",
                None,
                10,
                &cancel,
                Instant::now() + Duration::from_secs(2),
                |_| {}
            ),
            Err(Failure::Refused)
        );
        assert_eq!(
            get(
                "https://server-data-prod.lunii.com",
                None,
                10,
                &cancel,
                Instant::now(),
                |_| {}
            ),
            Err(Failure::Timeout)
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (ready, started) = mpsc::sync_channel(1);
        let (release, finish) = mpsc::sync_channel(1);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            assert!(read_request(&mut socket).starts_with("GET "));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n")
                .unwrap();
            ready.send(()).unwrap();
            let _ = finish.recv();
        });
        let cancelled = Arc::clone(&cancel);
        let trigger = std::thread::spawn(move || {
            started.recv().unwrap();
            cancelled.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        assert_eq!(
            get(
                &format!("http://{addr}"),
                None,
                10,
                &cancel,
                start + Duration::from_secs(2),
                |_| {}
            ),
            Err(Failure::Cancelled)
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        trigger.join().unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            get(
                "https://server-data-prod.lunii.com",
                None,
                10,
                &cancel,
                Instant::now() + Duration::from_secs(2),
                |_| {}
            ),
            Err(Failure::Cancelled)
        );
    }
}
