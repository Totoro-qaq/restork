use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{
    error::{ContractError, ContractResult},
    profile::ConfigurationProfile,
    validation::{normalize_optional_text, validate_locale, validate_timezone},
};

/// First day shown by the local calendar.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WeekStart {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

/// Dashboard appearance preference.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Light,
    Dark,
    Cyberpunk,
}

/// Workspace shown after a local session is restored.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupPage {
    Start,
    Dashboard,
}

/// Optional personal display preferences. Empty values defer to the system.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct PersonalSettings {
    display_name: Option<String>,
    locale: Option<String>,
    timezone: Option<String>,
    week_start: Option<WeekStart>,
    theme: Option<Theme>,
    startup_page: Option<StartupPage>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonalSettingsWire {
    display_name: Option<String>,
    locale: Option<String>,
    timezone: Option<String>,
    week_start: Option<WeekStart>,
    theme: Option<Theme>,
    startup_page: Option<StartupPage>,
}

impl PersonalSettings {
    pub fn try_new(
        display_name: Option<&str>,
        locale: Option<&str>,
        timezone: Option<&str>,
        week_start: Option<WeekStart>,
        theme: Option<Theme>,
        startup_page: Option<StartupPage>,
    ) -> ContractResult<Self> {
        let locale = locale.map(validate_locale).transpose()?;
        let timezone = timezone.map(validate_timezone).transpose()?;
        Ok(Self {
            display_name: normalize_optional_text(display_name, "display_name", 80)?,
            locale,
            timezone,
            week_start,
            theme,
            startup_page,
        })
    }

    /// Return an empty settings value without retaining prior personal fields.
    #[must_use]
    pub fn clear(self) -> Self {
        Self::default()
    }

    #[must_use]
    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    #[must_use]
    pub fn locale(&self) -> Option<&str> {
        self.locale.as_deref()
    }

    #[must_use]
    pub fn timezone(&self) -> Option<&str> {
        self.timezone.as_deref()
    }

    #[must_use]
    pub const fn startup_page(&self) -> Option<StartupPage> {
        self.startup_page
    }

    /// Display names enter prompts only through an explicitly opted-in profile.
    #[must_use]
    pub fn display_name_for_prompt<'a>(
        &'a self,
        profile: &ConfigurationProfile,
    ) -> Option<&'a str> {
        profile
            .include_display_name_in_prompt()
            .then(|| self.display_name())
            .flatten()
    }
}

impl<'de> Deserialize<'de> for PersonalSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = PersonalSettingsWire::deserialize(deserializer)?;
        Self::try_new(
            wire.display_name.as_deref(),
            wire.locale.as_deref(),
            wire.timezone.as_deref(),
            wire.week_start,
            wire.theme,
            wire.startup_page,
        )
        .map_err(serde::de::Error::custom)
    }
}

/// Semantic, locale-neutral time band produced by Core.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeBand {
    Morning,
    Noon,
    Afternoon,
    Evening,
    LateNight,
}

impl TimeBand {
    #[must_use]
    pub const fn from_hour(hour: u8) -> Self {
        match hour {
            5..=10 => Self::Morning,
            11..=13 => Self::Noon,
            14..=17 => Self::Afternoon,
            18..=22 => Self::Evening,
            _ => Self::LateNight,
        }
    }
}

/// A zero-configuration snapshot derived only from system time.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DailyContext {
    #[serde(with = "time::serde::rfc3339")]
    observed_at: OffsetDateTime,
    timezone: String,
    local_date: String,
    local_time: String,
    time_band: TimeBand,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DailyContextWire {
    #[serde(with = "time::serde::rfc3339")]
    observed_at: OffsetDateTime,
    timezone: String,
    local_date: String,
    local_time: String,
    time_band: TimeBand,
}

impl DailyContext {
    pub fn from_system_time() -> ContractResult<Self> {
        let observed = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
        Self::at(observed, "system")
    }

    pub fn at(observed_at: OffsetDateTime, timezone: &str) -> ContractResult<Self> {
        let timezone = validate_timezone(timezone)?;
        let date = observed_at.date();
        let time = observed_at.time();
        let local_date = format!(
            "{:04}-{:02}-{:02}",
            date.year(),
            u8::from(date.month()),
            date.day()
        );
        let local_time = format!(
            "{:02}:{:02}:{:02}",
            time.hour(),
            time.minute(),
            time.second()
        );
        Ok(Self {
            observed_at,
            timezone,
            local_date,
            local_time,
            time_band: TimeBand::from_hour(time.hour()),
        })
    }

    #[must_use]
    pub fn local_date(&self) -> &str {
        &self.local_date
    }

    #[must_use]
    pub fn local_time(&self) -> &str {
        &self.local_time
    }

    #[must_use]
    pub const fn time_band(&self) -> TimeBand {
        self.time_band
    }
}

impl<'de> Deserialize<'de> for DailyContext {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = DailyContextWire::deserialize(deserializer)?;
        let rebuilt =
            Self::at(wire.observed_at, &wire.timezone).map_err(serde::de::Error::custom)?;
        if rebuilt.local_date != wire.local_date
            || rebuilt.local_time != wire.local_time
            || rebuilt.time_band != wire.time_band
        {
            return Err(serde::de::Error::custom(ContractError::new(
                "daily_context",
                "derived time fields do not match observed_at",
            )));
        }
        Ok(rebuilt)
    }
}
