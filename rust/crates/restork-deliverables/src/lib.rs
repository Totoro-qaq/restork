//! Pure, deterministic domain contracts for reports, presentations, and exports.

pub mod approval;
pub mod deck;
pub mod error;
pub mod evidence;
mod hash;
pub mod report;
mod safety;
pub mod template;

pub use error::{DeliverableError, Result};
