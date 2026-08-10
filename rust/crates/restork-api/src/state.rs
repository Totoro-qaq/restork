//! Runtime state shared by authenticated route groups.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use restork_core::auth::PairingAuthority;
use restork_daily::DailyClient;
use restork_provider::ProviderClient;
use restork_storage::Database;

#[derive(Clone)]
pub(super) struct ApiState {
    pub(super) authority: PairingAuthority,
    pub(super) storage: Option<Arc<Database>>,
    pub(super) provider: Option<Arc<ProviderClient>>,
    pub(super) daily: Option<Arc<DailyClient>>,
    pub(super) operation_cancellations:
        Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    pub(super) run_cancellations: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    pub(super) subtask_slots: Arc<tokio::sync::Semaphore>,
    pub(super) vault_dir: Option<Arc<PathBuf>>,
}
