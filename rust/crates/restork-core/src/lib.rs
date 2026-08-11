//! Framework-independent Restork domain contracts.
//!
//! The modules here define scoped authorization, bounded run transitions,
//! evidence provenance, approvals, and the workspace model. They deliberately
//! avoid HTTP, desktop, and provider-specific dependencies.

pub mod auth;
pub mod durable_loop;
pub mod evidence;
pub mod run_loop;
pub mod workspace;
