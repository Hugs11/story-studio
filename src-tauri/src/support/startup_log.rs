//! Process logger: admission records stay in memory until the file logger is ready.
use std::sync::Mutex;

/// Records kept before the file logger exists. Only `Warn` and `Error` are
/// kept (a blocked process never attaches a logger), and the count is capped.
const MAX_PENDING: usize = 1000;

#[derive(Default)]
struct State {
    pending: Vec<(log::Level, String, String)>,
    dropped: usize,
    destination: Option<Box<dyn log::Log>>,
}

pub(crate) struct StartupLog(Mutex<State>);
pub(crate) static LOGGER: StartupLog = StartupLog(Mutex::new(State {
    pending: Vec::new(),
    dropped: 0,
    destination: None,
}));

impl Default for StartupLog {
    fn default() -> Self {
        Self(Mutex::new(State::default()))
    }
}

impl StartupLog {
    pub(crate) fn attach(&self, destination: Box<dyn log::Log>) {
        // Serialize replay and new records, including recovery worker records.
        let mut state = self.0.lock().unwrap();
        for (level, target, message) in state.pending.drain(..) {
            destination.log(
                &log::Record::builder()
                    .level(level)
                    .target(&target)
                    .args(format_args!("{message}"))
                    .build(),
            );
        }
        if state.dropped > 0 {
            let dropped = std::mem::take(&mut state.dropped);
            destination.log(
                &log::Record::builder()
                    .level(log::Level::Warn)
                    .target("boot")
                    .args(format_args!(
                        "{dropped} startup log records were dropped before the log file was ready"
                    ))
                    .build(),
            );
        }
        destination.flush();
        state.destination = Some(destination);
    }
}
impl log::Log for StartupLog {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        let mut state = self.0.lock().unwrap();
        if let Some(destination) = &state.destination {
            destination.log(record);
        } else if record.level() > log::Level::Warn {
            // Verbose startup records are not kept: nothing may ever drain them.
        } else if state.pending.len() >= MAX_PENDING {
            state.dropped += 1;
        } else {
            state.pending.push((
                record.level(),
                record.target().into(),
                record.args().to_string(),
            ));
        }
    }
    fn flush(&self) {
        if let Some(destination) = &self.0.lock().unwrap().destination {
            destination.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Log;
    #[test]
    fn admission_records_are_replayed_once_in_order() {
        struct Sink(std::sync::Arc<Mutex<Vec<String>>>);
        impl Log for Sink {
            fn enabled(&self, _: &log::Metadata<'_>) -> bool {
                true
            }
            fn log(&self, record: &log::Record<'_>) {
                self.0.lock().unwrap().push(record.args().to_string());
            }
            fn flush(&self) {}
        }
        let logger = StartupLog(Mutex::new(State::default()));
        let output = std::sync::Arc::new(Mutex::new(Vec::new()));
        logger.log(
            &log::Record::builder()
                .level(log::Level::Warn)
                .target("catalogue")
                .args(format_args!("modified .mbah recovery aborted"))
                .build(),
        );
        assert!(output.lock().unwrap().is_empty());
        logger.attach(Box::new(Sink(output.clone())));
        logger.log(&log::Record::builder().args(format_args!("ready")).build());
        assert_eq!(
            *output.lock().unwrap(),
            ["modified .mbah recovery aborted", "ready"]
        );
    }

    struct Sink(std::sync::Arc<Mutex<Vec<String>>>);
    impl Log for Sink {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }

    fn record(logger: &StartupLog, level: log::Level, message: &str) {
        logger.log(
            &log::Record::builder()
                .level(level)
                .args(format_args!("{message}"))
                .build(),
        );
    }

    #[test]
    fn verbose_records_are_not_buffered_before_attach() {
        let logger = StartupLog(Mutex::new(State::default()));
        record(&logger, log::Level::Trace, "trace");
        record(&logger, log::Level::Debug, "debug");
        record(&logger, log::Level::Info, "info");
        record(&logger, log::Level::Warn, "warn");
        record(&logger, log::Level::Error, "error");
        assert_eq!(logger.0.lock().unwrap().pending.len(), 2);
        let output = std::sync::Arc::new(Mutex::new(Vec::new()));
        logger.attach(Box::new(Sink(output.clone())));
        assert_eq!(*output.lock().unwrap(), ["warn", "error"]);
        record(&logger, log::Level::Trace, "live trace");
        assert_eq!(output.lock().unwrap().last().unwrap(), "live trace");
    }

    #[test]
    fn buffer_is_capped_and_loss_is_reported_once_on_replay() {
        let logger = StartupLog(Mutex::new(State::default()));
        for index in 0..MAX_PENDING + 5 {
            record(&logger, log::Level::Warn, &format!("w{index}"));
        }
        assert_eq!(logger.0.lock().unwrap().pending.len(), MAX_PENDING);
        let output = std::sync::Arc::new(Mutex::new(Vec::new()));
        logger.attach(Box::new(Sink(output.clone())));
        let lines = output.lock().unwrap();
        assert_eq!(lines.len(), MAX_PENDING + 1);
        assert_eq!(lines[0], "w0");
        assert!(lines[MAX_PENDING].starts_with("5 startup log records were dropped"));
        assert_eq!(lines.iter().filter(|l| l.contains("dropped")).count(), 1);
    }
}
