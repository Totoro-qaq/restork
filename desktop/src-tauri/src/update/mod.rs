#[cfg(any(test, not(debug_assertions)))]
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallSource {
    WebsiteDmg,
    WindowsStore,
    WindowsDirect,
    LinuxAppImage,
    LinuxSystemPackage,
    Source,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateOwner {
    Restork,
    MicrosoftStore,
    SystemPackageManager,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    ReadyToRestart,
    WaitingForIdle,
    Installing,
    Completed,
    InstallFailed,
    CheckFailed,
    VerificationFailed,
    PolicyRejected,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateScheduleMode {
    WhenIdle,
    Now,
    NextLaunch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct UpdatePreferences {
    pub channel: UpdateChannel,
    pub automatic_checks: bool,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
            automatic_checks: true,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub available_version: Option<String>,
    pub progress_percent: Option<u8>,
    pub owner: UpdateOwner,
    pub install_source: InstallSource,
    pub can_self_update: bool,
    pub preferences: UpdatePreferences,
    pub scheduled_mode: Option<UpdateScheduleMode>,
    pub last_checked_at_unix: Option<u64>,
    pub notification_dismissed: bool,
    pub detail: Option<&'static str>,
}

pub struct UpdateCoordinator {
    pub status: UpdateStatus,
    pub download_task: Option<JoinHandle<()>>,
    /// A fresh installation gets a quiet first session. Automatic discovery
    /// becomes eligible after the first launch has been recorded locally.
    pub automatic_check_eligible: bool,
    pub launch_count: u32,
    pub dismissed_version: Option<String>,
}

impl UpdateCoordinator {
    pub fn new(current_version: &str) -> Self {
        let install_source = install_source();
        let owner = owner(install_source);
        let can_self_update = owner == UpdateOwner::Restork && signed_updates_enabled();
        Self {
            status: UpdateStatus {
                phase: UpdatePhase::Idle,
                current_version: current_version.to_owned(),
                available_version: None,
                progress_percent: None,
                owner,
                install_source,
                can_self_update,
                preferences: UpdatePreferences::default(),
                scheduled_mode: None,
                last_checked_at_unix: None,
                notification_dismissed: false,
                detail: None,
            },
            download_task: None,
            automatic_check_eligible: false,
            launch_count: 0,
            dismissed_version: None,
        }
    }

    pub fn begin_check(&mut self) -> Result<(), &'static str> {
        if self.status.owner != UpdateOwner::Restork {
            self.status.detail = Some(match self.status.owner {
                UpdateOwner::MicrosoftStore => "managed_by_microsoft_store",
                UpdateOwner::SystemPackageManager => "managed_by_system_package_manager",
                UpdateOwner::Manual => "manual_install_source",
                UpdateOwner::Restork => unreachable!(),
            });
            return Err("update_managed_externally");
        }
        self.status.phase = UpdatePhase::Checking;
        self.status.detail = None;
        Ok(())
    }

    #[cfg(any(test, not(debug_assertions)))]
    pub fn checked(&mut self, version: Option<String>) {
        self.status.last_checked_at_unix = Some(now_unix());
        self.status.available_version = version;
        self.status.notification_dismissed =
            self.status.available_version.as_deref() == self.dismissed_version.as_deref();
        self.status.phase = if self.status.available_version.is_some() {
            UpdatePhase::Available
        } else {
            UpdatePhase::UpToDate
        };
    }

    pub fn dismiss_available(&mut self, version: &str) -> Result<(), &'static str> {
        if self.status.phase != UpdatePhase::Available
            || self.status.available_version.as_deref() != Some(version)
        {
            return Err("update_not_available");
        }
        self.dismissed_version = Some(version.to_owned());
        self.status.notification_dismissed = true;
        Ok(())
    }

    pub fn schedule(&mut self, mode: UpdateScheduleMode) -> Result<(), &'static str> {
        if !self.status.can_self_update || self.status.phase != UpdatePhase::ReadyToRestart {
            return Err("update_not_ready");
        }
        self.status.scheduled_mode = Some(mode);
        self.status.phase = match mode {
            UpdateScheduleMode::Now => UpdatePhase::Installing,
            UpdateScheduleMode::WhenIdle | UpdateScheduleMode::NextLaunch => {
                UpdatePhase::WaitingForIdle
            }
        };
        Ok(())
    }

    pub fn cancel_download(&mut self) -> Result<(), &'static str> {
        let Some(task) = self.download_task.take() else {
            return Err("update_download_not_active");
        };
        task.abort();
        self.status.phase = if self.status.available_version.is_some() {
            UpdatePhase::Available
        } else {
            UpdatePhase::Idle
        };
        self.status.progress_percent = None;
        self.status.detail = Some("download_cancelled");
        Ok(())
    }

    #[cfg(any(test, not(debug_assertions)))]
    pub fn should_automatically_check(&self, now: u64) -> bool {
        const CHECK_INTERVAL_SECONDS: u64 = 24 * 60 * 60;
        self.automatic_check_eligible
            && self.status.preferences.automatic_checks
            && self
                .status
                .last_checked_at_unix
                .is_none_or(|last| now.saturating_sub(last) >= CHECK_INTERVAL_SECONDS)
    }
}

#[cfg(any(test, not(debug_assertions)))]
pub(crate) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs())
}

fn signed_updates_enabled() -> bool {
    option_env!("RESTORK_SIGNED_UPDATES") == Some("1")
}

fn install_source() -> InstallSource {
    match option_env!("RESTORK_INSTALL_SOURCE") {
        Some("website_dmg") => InstallSource::WebsiteDmg,
        Some("windows_store") => InstallSource::WindowsStore,
        Some("windows_direct") => InstallSource::WindowsDirect,
        Some("linux_appimage") => InstallSource::LinuxAppImage,
        Some("linux_system_package") => InstallSource::LinuxSystemPackage,
        _ if cfg!(debug_assertions) => InstallSource::Source,
        _ if cfg!(target_os = "macos") => InstallSource::WebsiteDmg,
        _ if cfg!(target_os = "windows") => InstallSource::WindowsDirect,
        _ if std::env::var_os("APPIMAGE").is_some() => InstallSource::LinuxAppImage,
        _ => InstallSource::LinuxSystemPackage,
    }
}

fn owner(source: InstallSource) -> UpdateOwner {
    match source {
        InstallSource::WebsiteDmg | InstallSource::WindowsDirect | InstallSource::LinuxAppImage => {
            UpdateOwner::Restork
        }
        InstallSource::WindowsStore => UpdateOwner::MicrosoftStore,
        InstallSource::LinuxSystemPackage => UpdateOwner::SystemPackageManager,
        InstallSource::Source => UpdateOwner::Manual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_builds_are_manual_and_never_claim_silent_updates() {
        let coordinator = UpdateCoordinator::new("0.1.2");
        assert_eq!(coordinator.status.install_source, InstallSource::Source);
        assert_eq!(coordinator.status.owner, UpdateOwner::Manual);
        assert!(!coordinator.status.can_self_update);
    }

    #[test]
    fn scheduling_requires_a_verified_download() {
        let mut coordinator = UpdateCoordinator::new("0.1.2");
        assert_eq!(
            coordinator.schedule(UpdateScheduleMode::Now),
            Err("update_not_ready")
        );
    }

    #[test]
    fn automatic_checks_wait_a_full_day_and_can_be_disabled() {
        let mut coordinator = UpdateCoordinator::new("0.1.2");
        coordinator.automatic_check_eligible = true;
        coordinator.status.last_checked_at_unix = Some(100);
        assert!(!coordinator.should_automatically_check(100 + 23 * 60 * 60));
        assert!(coordinator.should_automatically_check(100 + 24 * 60 * 60));
        coordinator.status.preferences.automatic_checks = false;
        assert!(!coordinator.should_automatically_check(u64::MAX));
    }

    #[test]
    fn first_launch_never_checks_automatically() {
        let coordinator = UpdateCoordinator::new("0.1.2");
        assert!(!coordinator.should_automatically_check(u64::MAX));
    }

    #[test]
    fn a_completed_check_records_time_and_availability() {
        let mut coordinator = UpdateCoordinator::new("0.1.2");
        coordinator.checked(Some("0.1.3".into()));
        assert_eq!(coordinator.status.phase, UpdatePhase::Available);
        assert_eq!(
            coordinator.status.available_version.as_deref(),
            Some("0.1.3")
        );
        assert!(coordinator.status.last_checked_at_unix.is_some());
    }

    #[test]
    fn dismissing_one_version_does_not_hide_a_later_version() {
        let mut coordinator = UpdateCoordinator::new("0.1.2");
        coordinator.checked(Some("0.1.3".into()));
        coordinator.dismiss_available("0.1.3").unwrap();
        assert!(coordinator.status.notification_dismissed);
        coordinator.checked(Some("0.1.4".into()));
        assert!(!coordinator.status.notification_dismissed);
    }
}
