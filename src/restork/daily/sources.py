"""Provider-neutral music-source registry shared by the compatibility API."""

from __future__ import annotations

from restork.daily.models import MusicSourceCapabilities, MusicSourceDefinition


def music_source_registry(
    *, apple_developer_credential_present: bool
) -> tuple[MusicSourceDefinition, ...]:
    return (
        MusicSourceDefinition(
            provider="local-file",
            label="Local JSON / CSV",
            stability="stable",
            credential_mode="none",
            setup_status="ready",
            capabilities=MusicSourceCapabilities(read_only=True),
        ),
        MusicSourceDefinition(
            provider="qqmusic",
            label="QQ Music",
            stability="experimental",
            credential_mode="none",
            setup_status="ready",
            capabilities=MusicSourceCapabilities(
                read_only=True,
                refresh_supported=True,
                supports_public_playlists=True,
                supports_charts=True,
            ),
        ),
        MusicSourceDefinition(
            provider="netease",
            label="NetEase Cloud Music",
            stability="experimental",
            credential_mode="none",
            setup_status="ready",
            capabilities=MusicSourceCapabilities(
                read_only=True,
                refresh_supported=True,
                supports_public_playlists=True,
            ),
        ),
        MusicSourceDefinition(
            provider="apple-music",
            label="Apple Music",
            stability="official",
            credential_mode="native_secret",
            setup_status=(
                "ready" if apple_developer_credential_present else "credential_missing"
            ),
            setup_command="restorkd music apple configure",
            capabilities=MusicSourceCapabilities(
                read_only=True,
                refresh_supported=True,
                supports_public_playlists=True,
                supports_library=False,
                requires_user_consent=True,
            ),
        ),
    )


__all__ = ["music_source_registry"]
