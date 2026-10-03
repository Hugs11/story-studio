//! Suite de la projection de lecture avancée.
//!
//! Elle est **pure** : aucun disque, aucune commande Tauri, aucun corpus privé.
//! Les documents sont écrits comme des chaînes de payload, pour que le contrôle
//! porte sur ce qu'un `.mbah` porte réellement et non sur un objet Rust
//! reconstruit.

mod bench;
mod fixtures;
mod projection;
mod resilience;
