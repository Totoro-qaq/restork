use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use serde::{Deserialize, Serialize};

const ONBOARDING_FILE: &str = "onboarding-state.json";
const ONBOARDING_PENDING_FILE: &str = "onboarding-state.pending";
const ONBOARDING_STATE_LIMIT: u64 = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OnboardingState {
    pub(crate) version: u8,
    pub(crate) dismissed: bool,
}

impl Default for OnboardingState {
    fn default() -> Self {
        Self {
            version: 1,
            dismissed: false,
        }
    }
}

pub(crate) fn load_onboarding_state(data_root: &Path) -> OnboardingState {
    let path = data_root.join(ONBOARDING_FILE);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return OnboardingState::default();
    };
    if metadata.file_type().is_symlink() || metadata.len() > ONBOARDING_STATE_LIMIT {
        return OnboardingState::default();
    }
    let Ok(bytes) = fs::read(path) else {
        return OnboardingState::default();
    };
    serde_json::from_slice::<OnboardingState>(&bytes)
        .ok()
        .filter(|state| state.version == 1)
        .unwrap_or_default()
}

pub(crate) fn save_onboarding_state(
    data_root: &Path,
    dismissed: bool,
) -> Result<OnboardingState, &'static str> {
    fs::create_dir_all(data_root).map_err(|_| "onboarding_state_unavailable")?;
    let state = OnboardingState {
        version: 1,
        dismissed,
    };
    let bytes = serde_json::to_vec(&state).map_err(|_| "onboarding_state_unavailable")?;
    let pending = data_root.join(ONBOARDING_PENDING_FILE);
    let target = data_root.join(ONBOARDING_FILE);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&pending)
        .map_err(|_| "onboarding_state_unavailable")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "onboarding_state_unavailable")?;
    #[cfg(unix)]
    fs::set_permissions(&pending, fs::Permissions::from_mode(0o600))
        .map_err(|_| "onboarding_state_unavailable")?;
    fs::rename(&pending, &target).map_err(|_| "onboarding_state_unavailable")?;
    if let Ok(directory) = fs::File::open(data_root) {
        let _ = directory.sync_all();
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::{OnboardingState, load_onboarding_state, save_onboarding_state};

    #[test]
    fn onboarding_state_is_minimal_recoverable_and_strict() {
        let root = tempfile::tempdir().expect("temp root");
        assert_eq!(
            load_onboarding_state(root.path()),
            OnboardingState::default()
        );

        let saved = save_onboarding_state(root.path(), true).expect("save state");
        assert!(saved.dismissed);
        assert_eq!(load_onboarding_state(root.path()), saved);

        std::fs::write(
            root.path().join("onboarding-state.json"),
            br#"{"version":1,"dismissed":true,"path":"private"}"#,
        )
        .expect("write malformed state");
        assert_eq!(
            load_onboarding_state(root.path()),
            OnboardingState::default()
        );
    }

    #[cfg(unix)]
    #[test]
    fn onboarding_state_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("temp root");
        save_onboarding_state(root.path(), true).expect("save state");
        let metadata =
            std::fs::metadata(root.path().join("onboarding-state.json")).expect("state metadata");
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
}
