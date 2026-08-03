//! Provider-neutral music-source capability and document contracts.
//!
//! Source adapters own transport and provider parsing. The rest of Restork consumes only
//! these normalized, bounded records.

use serde::{Deserialize, Serialize};

use super::{MusicDiscovery, MusicSourceSummary, PlaylistItem};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicSourceCapabilities {
    pub read_only: bool,
    pub refresh_supported: bool,
    pub supports_public_playlists: bool,
    pub supports_library: bool,
    pub supports_charts: bool,
    pub requires_user_consent: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicSourceDefinition {
    pub provider: String,
    pub label: String,
    pub stability: String,
    pub credential_mode: String,
    pub setup_status: String,
    pub setup_command: String,
    pub capabilities: MusicSourceCapabilities,
}

#[derive(Clone, Debug)]
pub struct MusicSourceDocument {
    pub provider: String,
    pub source_identity: String,
    pub items: Vec<PlaylistItem>,
    pub source: MusicSourceSummary,
    pub discoveries: Vec<MusicDiscovery>,
}

/// Return the stable registry order used by Core and the Dashboard.
#[must_use]
pub fn music_source_registry(
    apple_developer_credential_present: bool,
) -> Vec<MusicSourceDefinition> {
    vec![
        MusicSourceDefinition {
            provider: "local-file".to_owned(),
            label: "Local JSON / CSV".to_owned(),
            stability: "stable".to_owned(),
            credential_mode: "none".to_owned(),
            setup_status: "ready".to_owned(),
            setup_command: String::new(),
            capabilities: MusicSourceCapabilities {
                read_only: true,
                refresh_supported: false,
                supports_public_playlists: false,
                supports_library: false,
                supports_charts: false,
                requires_user_consent: false,
            },
        },
        MusicSourceDefinition {
            provider: "qqmusic".to_owned(),
            label: "QQ Music".to_owned(),
            stability: "experimental".to_owned(),
            credential_mode: "none".to_owned(),
            setup_status: "ready".to_owned(),
            setup_command: String::new(),
            capabilities: MusicSourceCapabilities {
                read_only: true,
                refresh_supported: true,
                supports_public_playlists: true,
                supports_library: false,
                supports_charts: true,
                requires_user_consent: false,
            },
        },
        MusicSourceDefinition {
            provider: "netease".to_owned(),
            label: "NetEase Cloud Music".to_owned(),
            stability: "experimental".to_owned(),
            credential_mode: "none".to_owned(),
            setup_status: "ready".to_owned(),
            setup_command: String::new(),
            capabilities: MusicSourceCapabilities {
                read_only: true,
                refresh_supported: true,
                supports_public_playlists: true,
                supports_library: false,
                supports_charts: false,
                requires_user_consent: false,
            },
        },
        MusicSourceDefinition {
            provider: "apple-music".to_owned(),
            label: "Apple Music".to_owned(),
            stability: "official".to_owned(),
            credential_mode: "native_secret".to_owned(),
            setup_status: if apple_developer_credential_present {
                "ready"
            } else {
                "credential_missing"
            }
            .to_owned(),
            setup_command: "restorkd music apple configure".to_owned(),
            capabilities: MusicSourceCapabilities {
                read_only: true,
                refresh_supported: true,
                supports_public_playlists: true,
                supports_library: false,
                supports_charts: false,
                requires_user_consent: true,
            },
        },
    ]
}

#[cfg(target_os = "macos")]
#[must_use]
pub const fn apple_developer_token_reference() -> &'static str {
    "keychain:restork/music/apple/developer-token"
}

#[cfg(target_os = "linux")]
#[must_use]
pub const fn apple_developer_token_reference() -> &'static str {
    "secret-service:restork/music/apple/developer-token"
}

#[cfg(windows)]
#[must_use]
pub const fn apple_developer_token_reference() -> &'static str {
    "credential-manager:restork/music/apple/developer-token"
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
#[must_use]
pub const fn apple_developer_token_reference() -> &'static str {
    "keychain:restork/music/apple/developer-token"
}

#[cfg(target_os = "macos")]
#[must_use]
pub const fn apple_music_user_token_reference() -> &'static str {
    "keychain:restork/music/apple/music-user-token"
}

#[cfg(target_os = "linux")]
#[must_use]
pub const fn apple_music_user_token_reference() -> &'static str {
    "secret-service:restork/music/apple/music-user-token"
}

#[cfg(windows)]
#[must_use]
pub const fn apple_music_user_token_reference() -> &'static str {
    "credential-manager:restork/music/apple/music-user-token"
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
#[must_use]
pub const fn apple_music_user_token_reference() -> &'static str {
    "keychain:restork/music/apple/music-user-token"
}

#[cfg(test)]
mod tests {
    use super::music_source_registry;

    #[test]
    fn registry_declares_stability_and_credential_state() {
        let missing = music_source_registry(false);
        assert_eq!(
            missing
                .iter()
                .map(|item| item.provider.as_str())
                .collect::<Vec<_>>(),
            vec!["local-file", "qqmusic", "netease", "apple-music"]
        );
        let apple = missing.last().expect("apple source");
        assert_eq!(apple.stability, "official");
        assert_eq!(apple.setup_status, "credential_missing");
        assert!(apple.capabilities.requires_user_consent);
        assert!(!apple.capabilities.supports_library);

        let ready = music_source_registry(true);
        assert_eq!(ready.last().expect("apple source").setup_status, "ready");
    }
}
