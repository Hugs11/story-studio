//! Cooperative cancellation at shared import I/O and child-process boundaries.
use crate::support::user_message::{codes, UserMessage};
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
pub(crate) fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err(UserMessage::new(codes::GENERATION_CANCELLED).into_transport())
    } else {
        Ok(())
    }
}
#[cfg(test)]
type Hook = Box<dyn FnMut(&str, &AtomicBool)>;
#[cfg(test)]
thread_local! {pub(crate) static STEP:std::cell::RefCell<Option<Hook>>=const {std::cell::RefCell::new(None)};}
fn checkpoint(stage: &str, cancel: &AtomicBool) -> io::Result<()> {
    #[cfg(test)]
    STEP.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(stage, cancel);
        }
    });
    #[cfg(not(test))]
    let _ = stage;
    check(cancel).map_err(io::Error::other)
}
pub(crate) fn copy(
    input: &mut impl Read,
    output: &mut impl Write,
    cancel: &AtomicBool,
) -> io::Result<u64> {
    let mut buffer = [0; 65536];
    let mut total = 0;
    loop {
        check(cancel).map_err(io::Error::other)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            return Ok(total);
        }
        output.write_all(&buffer[..n])?;
        total += n as u64;
        checkpoint("copyChunk", cancel)?;
    }
}
pub(crate) fn read(path: &Path, cancel: &AtomicBool) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    copy(&mut std::fs::File::open(path)?, &mut bytes, cancel)?;
    Ok(bytes)
}
pub(crate) struct Writer<'a, W> {
    pub inner: W,
    pub cancel: &'a AtomicBool,
    pub stage: &'static str,
}
impl<W: Write> Write for Writer<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        checkpoint(self.stage, self.cancel)?;
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        check(self.cancel).map_err(io::Error::other)?;
        self.inner.flush()
    }
}
impl<W: io::Seek> io::Seek for Writer<'_, W> {
    fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
        check(self.cancel).map_err(io::Error::other)?;
        self.inner.seek(pos)
    }
}
/// Own the process until it has exited, including when cancellation arrives.
/// Bounded pipe readers prevent a verbose archive tool from blocking its owner.
pub(super) fn run(mut command: Command, cancel: &AtomicBool) -> io::Result<Output> {
    check(cancel).map_err(io::Error::other)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let overflow = Arc::new(AtomicBool::new(false));
    let read_pipe = |pipe: Box<dyn Read + Send>| {
        let overflow = Arc::clone(&overflow);
        std::thread::spawn(move || {
            const LIMIT: u64 = 16 * 1024 * 1024;
            let mut bytes = Vec::new();
            pipe.take(LIMIT + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > LIMIT {
                overflow.store(true, Ordering::Relaxed);
            }
            Ok::<_, io::Error>(bytes)
        })
    };
    let stdout = read_pipe(Box::new(child.stdout.take().unwrap()));
    let stderr = read_pipe(Box::new(child.stderr.take().unwrap()));
    let start = checkpoint("archiveProcessStarted", cancel);
    let status = loop {
        if start.is_err() || cancel.load(Ordering::Relaxed) || overflow.load(Ordering::Relaxed) {
            let _ = child.kill();
            break child.wait();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let stdout = stdout
        .join()
        .map_err(|_| io::Error::other("archive stdout reader stopped"))??;
    let stderr = stderr
        .join()
        .map_err(|_| io::Error::other("archive stderr reader stopped"))??;
    check(cancel).map_err(io::Error::other)?;
    if overflow.load(Ordering::Relaxed) {
        return Err(io::Error::other("archive output limit exceeded"));
    }
    Ok(Output {
        status: status?,
        stdout,
        stderr,
    })
}
