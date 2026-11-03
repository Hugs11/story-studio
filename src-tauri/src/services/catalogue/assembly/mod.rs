//! Owned, revalidated inputs for the aggregation assistant.
mod ownership;
mod prepare;
use crate::support::user_message::UserMessage;
pub use ownership::Registry;
pub use prepare::{Request, Selection};
fn failed() -> UserMessage {
    UserMessage::new(crate::support::user_message::codes::CATALOG_ASSEMBLY_PREPARATION_FAILED)
}

#[cfg(test)]
mod ownership_tests;
