//! Resolution of durable catalogue values, independent of source availability.
pub mod card;
pub mod images;
pub mod journal;
pub mod organization;
pub mod resolver;
pub mod mutate {
    pub mod association;
    pub mod bulk;
    pub mod favorite;
    pub mod forget;
    pub mod metadata;
    pub mod names;
    pub mod reference;
    pub mod tags;
}
#[cfg(test)]
mod tests;
