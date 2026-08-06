//! In-memory, short-lived pairing challenges and scoped bearer tokens.

use std::{
    collections::BTreeSet,
    error::Error,
    fmt,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use subtle::ConstantTimeEq;

pub const RUNS_READ: &str = "runs:read";
pub const RUNS_WRITE: &str = "runs:write";
pub const APPROVALS_READ: &str = "approvals:read";
pub const APPROVALS_DECIDE: &str = "approvals:decide";
pub const EFFECTS_RESOLVE: &str = "effects:resolve";
pub const TOKENS_MANAGE: &str = "tokens:manage";
pub const MEMORY_READ: &str = "memory:read";
pub const MEMORY_WRITE: &str = "memory:write";
pub const TASKS_READ: &str = "tasks:read";
pub const TASKS_WRITE: &str = "tasks:write";
pub const RADAR_READ: &str = "radar:read";
pub const RADAR_WRITE: &str = "radar:write";
pub const DAILY_READ: &str = "daily:read";
pub const DAILY_CONFIGURE: &str = "daily:configure";
pub const SETTINGS_READ: &str = "settings:read";
pub const SETTINGS_WRITE: &str = "settings:write";
pub const SESSIONS_READ: &str = "sessions:read";
pub const SESSIONS_WRITE: &str = "sessions:write";
pub const SESSIONS_EXPORT: &str = "sessions:export";
pub const SESSIONS_DELETE: &str = "sessions:delete";
pub const PROFILES_READ: &str = "profiles:read";
pub const PROFILES_MANAGE: &str = "profiles:manage";
pub const PROVIDERS_READ: &str = "providers:read";
pub const PROVIDERS_MANAGE: &str = "providers:manage";
pub const PROMPTS_READ: &str = "prompts:read";
pub const PROMPTS_MANAGE: &str = "prompts:manage";
pub const EXTENSIONS_READ: &str = "extensions:read";
pub const EXTENSIONS_MANAGE: &str = "extensions:manage";
pub const MCP_READ: &str = "mcp:read";
pub const MCP_MANAGE: &str = "mcp:manage";
pub const TOOLS_DISCOVER: &str = "tools:discover";
pub const TOOLS_INVOKE: &str = "tools:invoke";
pub const DELIVERABLES_READ: &str = "deliverables:read";
pub const DELIVERABLES_COMPOSE: &str = "deliverables:compose";
pub const DELIVERABLES_EXPORT: &str = "deliverables:export";
pub const TEMPLATES_MANAGE: &str = "templates:manage";
pub const SCHEDULES_READ: &str = "schedules:read";
pub const SCHEDULES_MANAGE: &str = "schedules:manage";
pub const CHECKPOINTS_READ: &str = "checkpoints:read";
pub const CHECKPOINTS_RESTORE: &str = "checkpoints:restore";
pub const SUBTASKS_READ: &str = "subtasks:read";
pub const SUBTASKS_MANAGE: &str = "subtasks:manage";
pub const EVALS_READ: &str = "evals:read";
pub const EVALS_RUN: &str = "evals:run";
pub const EVALS_EXPORT: &str = "evals:export";

pub const WEB_SCOPES: &[&str] = &[
    RUNS_READ,
    RUNS_WRITE,
    APPROVALS_READ,
    APPROVALS_DECIDE,
    EFFECTS_RESOLVE,
    TOKENS_MANAGE,
    MEMORY_READ,
    MEMORY_WRITE,
    TASKS_READ,
    TASKS_WRITE,
    RADAR_READ,
    RADAR_WRITE,
    DAILY_READ,
    DAILY_CONFIGURE,
    SETTINGS_READ,
    SETTINGS_WRITE,
    SESSIONS_READ,
    SESSIONS_WRITE,
    SESSIONS_EXPORT,
    SESSIONS_DELETE,
    PROFILES_READ,
    PROFILES_MANAGE,
    PROVIDERS_READ,
    PROVIDERS_MANAGE,
    PROMPTS_READ,
    PROMPTS_MANAGE,
    EXTENSIONS_READ,
    EXTENSIONS_MANAGE,
    MCP_READ,
    MCP_MANAGE,
    TOOLS_DISCOVER,
    TOOLS_INVOKE,
    DELIVERABLES_READ,
    DELIVERABLES_COMPOSE,
    DELIVERABLES_EXPORT,
    TEMPLATES_MANAGE,
    SCHEDULES_READ,
    SCHEDULES_MANAGE,
    CHECKPOINTS_READ,
    CHECKPOINTS_RESTORE,
    SUBTASKS_READ,
    SUBTASKS_MANAGE,
    EVALS_READ,
    EVALS_RUN,
    EVALS_EXPORT,
];
pub const CLI_SCOPES: &[&str] = WEB_SCOPES;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Audience {
    Web,
    Cli,
}

impl Audience {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Web => "restork-web",
            Self::Cli => "restork-cli",
        }
    }

    const fn maximum_scopes(self) -> &'static [&'static str] {
        match self {
            Self::Web => WEB_SCOPES,
            Self::Cli => CLI_SCOPES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthError {
    InvalidTtl,
    EntropyUnavailable,
    AuthorityUnavailable,
    ScopeEscalation,
    InvalidPairingCode,
    ExpiredPairingCode,
    PairingWrongAudience,
    InvalidOrExpiredToken,
    WrongAudience,
    MissingScope,
}

impl fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidTtl => "token TTL must be positive",
            Self::EntropyUnavailable => "secure random generation is unavailable",
            Self::AuthorityUnavailable => "pairing authority is unavailable",
            Self::ScopeEscalation => "pairing scopes exceed the audience policy",
            Self::InvalidPairingCode => {
                "invalid pairing code; it may already have been used, or Core was restarted \
                 since it was printed"
            }
            Self::ExpiredPairingCode => "pairing code has expired; restart Core to print a new one",
            Self::PairingWrongAudience => {
                "this pairing code belongs to the other client; use the Web code in the browser \
                 and the CLI code with `restorkd`. The code is still valid for its own client"
            }
            Self::InvalidOrExpiredToken => "invalid or expired access token",
            Self::WrongAudience => "access token has the wrong audience",
            Self::MissingScope => "access token lacks the required scope",
        };
        formatter.write_str(message)
    }
}

impl Error for AuthError {}

pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct AccessToken {
    value: String,
    audience: Audience,
    scopes: BTreeSet<String>,
    expires_at: SystemTime,
}

impl AccessToken {
    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }

    #[must_use]
    pub const fn audience(&self) -> Audience {
        self.audience
    }

    #[must_use]
    pub const fn scopes(&self) -> &BTreeSet<String> {
        &self.scopes
    }

    #[must_use]
    pub const fn expires_at(&self) -> SystemTime {
        self.expires_at
    }
}

impl fmt::Debug for AccessToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AccessToken")
            .field("value", &"[REDACTED]")
            .field("audience", &self.audience)
            .field("scopes", &self.scopes)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

struct PairingChallenge {
    code: String,
    audience: Audience,
    scopes: BTreeSet<String>,
    expires_at: SystemTime,
}

#[derive(Default)]
struct AuthorityState {
    challenges: Vec<PairingChallenge>,
    tokens: Vec<AccessToken>,
}

/// A pairing code is transcribed by a human from a terminal into a browser, so
/// it needs long enough to read the instructions. An access token is renewed by
/// the client and can be short. Governing both with one value forced a choice
/// between an unusable first run and a long-lived credential.
pub const DEFAULT_PAIRING_TTL: Duration = Duration::from_secs(900);
pub const DEFAULT_TOKEN_TTL: Duration = Duration::from_secs(1800);

#[derive(Clone)]
pub struct PairingAuthority {
    pairing_ttl: Duration,
    token_ttl: Duration,
    clock: Arc<dyn Clock>,
    state: Arc<Mutex<AuthorityState>>,
    initial_code: Arc<str>,
}

impl fmt::Debug for PairingAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (challenges, tokens) = self
            .state
            .lock()
            .map(|state| (state.challenges.len(), state.tokens.len()))
            .unwrap_or_default();
        formatter
            .debug_struct("PairingAuthority")
            .field("pairing_ttl", &self.pairing_ttl)
            .field("token_ttl", &self.token_ttl)
            .field("challenges", &challenges)
            .field("tokens", &tokens)
            .finish()
    }
}

impl PairingAuthority {
    /// Applies one `ttl` to both pairing codes and access tokens.
    ///
    /// Retained with its original meaning so existing callers are unaffected.
    /// Callers that want the two lifetimes to differ opt in explicitly through
    /// [`Self::with_ttls`].
    pub fn new(ttl: Duration) -> Result<Self, AuthError> {
        Self::with_clock(ttl, Arc::new(SystemClock))
    }

    pub fn with_ttls(pairing_ttl: Duration, token_ttl: Duration) -> Result<Self, AuthError> {
        Self::with_ttls_and_clock(pairing_ttl, token_ttl, Arc::new(SystemClock))
    }

    pub fn with_clock<C>(ttl: Duration, clock: Arc<C>) -> Result<Self, AuthError>
    where
        C: Clock + 'static,
    {
        Self::with_ttls_and_clock(ttl, ttl, clock)
    }

    pub fn with_ttls_and_clock<C>(
        pairing_ttl: Duration,
        token_ttl: Duration,
        clock: Arc<C>,
    ) -> Result<Self, AuthError>
    where
        C: Clock + 'static,
    {
        if pairing_ttl.is_zero() || token_ttl.is_zero() {
            return Err(AuthError::InvalidTtl);
        }
        let clock: Arc<dyn Clock> = clock;
        let now = clock.now();
        let expires_at = now.checked_add(pairing_ttl).ok_or(AuthError::InvalidTtl)?;
        let initial_code = random_hex::<24>()?;
        let initial_scopes = scope_set(WEB_SCOPES);
        let initial_challenge = PairingChallenge {
            code: initial_code.clone(),
            audience: Audience::Web,
            scopes: initial_scopes,
            expires_at,
        };
        Ok(Self {
            pairing_ttl,
            token_ttl,
            clock,
            state: Arc::new(Mutex::new(AuthorityState {
                challenges: vec![initial_challenge],
                tokens: Vec::new(),
            })),
            initial_code: Arc::from(initial_code),
        })
    }

    #[must_use]
    pub fn initial_pairing_code(&self) -> String {
        self.initial_code.to_string()
    }

    pub fn new_pairing_code(
        &self,
        audience: Audience,
        scopes: &[&str],
    ) -> Result<String, AuthError> {
        let requested = scope_set(scopes);
        let maximum = scope_set(audience.maximum_scopes());
        if requested.is_empty() || !requested.is_subset(&maximum) {
            return Err(AuthError::ScopeEscalation);
        }
        let code = random_hex::<24>()?;
        let expires_at = self.expiration()?;
        self.state
            .lock()
            .map_err(|_| AuthError::AuthorityUnavailable)?
            .challenges
            .push(PairingChallenge {
                code: code.clone(),
                audience,
                scopes: requested,
                expires_at,
            });
        Ok(code)
    }

    pub fn pair(&self, code: &str, audience: Audience) -> Result<AccessToken, AuthError> {
        let now = self.clock.now();
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuthError::AuthorityUnavailable)?;
        let challenge_index = secret_position(&state.challenges, code, |item| &item.code)
            .ok_or(AuthError::InvalidPairingCode)?;

        // Inspect before consuming. Removing the challenge first meant that
        // presenting the Web code to the CLI destroyed it, after which the
        // browser could never pair and the only recovery was restarting Core.
        // A code offered to the wrong audience MUST survive for its own one.
        if state.challenges[challenge_index].audience != audience {
            return Err(AuthError::PairingWrongAudience);
        }
        // An expired challenge is consumed: it is dead either way, and leaving
        // it in place would let the same dead code be retried indefinitely.
        let challenge = state.challenges.remove(challenge_index);
        if challenge.expires_at <= now {
            return Err(AuthError::ExpiredPairingCode);
        }
        let token = AccessToken {
            value: random_hex::<32>()?,
            audience: challenge.audience,
            scopes: challenge.scopes,
            expires_at: now
                .checked_add(self.token_ttl)
                .ok_or(AuthError::InvalidTtl)?,
        };
        state.tokens.push(token.clone());
        Ok(token)
    }

    pub fn verify(
        &self,
        value: &str,
        audiences: &[Audience],
        required_scopes: &[&str],
    ) -> Result<AccessToken, AuthError> {
        let now = self.clock.now();
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuthError::AuthorityUnavailable)?;
        let token_index = secret_position(&state.tokens, value, |item| &item.value)
            .ok_or(AuthError::InvalidOrExpiredToken)?;
        if state.tokens[token_index].expires_at <= now {
            state.tokens.remove(token_index);
            return Err(AuthError::InvalidOrExpiredToken);
        }
        let token = &state.tokens[token_index];
        if !audiences.contains(&token.audience) {
            return Err(AuthError::WrongAudience);
        }
        if !required_scopes
            .iter()
            .all(|scope| token.scopes.contains(*scope))
        {
            return Err(AuthError::MissingScope);
        }
        Ok(token.clone())
    }

    pub fn rotate(&self, value: &str, audiences: &[Audience]) -> Result<AccessToken, AuthError> {
        self.rotate_with_grace(value, audiences, Duration::ZERO)
    }

    /// Replace a token that is still valid or expired within a tightly bounded
    /// recovery window. Expired tokens remain unusable for every other API
    /// operation; this exists so a suspended desktop WebView can recover its
    /// short-lived session after its timers resume.
    pub fn rotate_with_grace(
        &self,
        value: &str,
        audiences: &[Audience],
        grace: Duration,
    ) -> Result<AccessToken, AuthError> {
        let replacement_value = random_hex::<32>()?;
        let now = self.clock.now();
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuthError::AuthorityUnavailable)?;
        let token_index = secret_position(&state.tokens, value, |item| &item.value)
            .ok_or(AuthError::InvalidOrExpiredToken)?;
        let current = &state.tokens[token_index];
        let recoverable_until = current
            .expires_at
            .checked_add(grace)
            .ok_or(AuthError::InvalidTtl)?;
        if recoverable_until <= now {
            state.tokens.remove(token_index);
            return Err(AuthError::InvalidOrExpiredToken);
        }
        if !audiences.contains(&current.audience) {
            return Err(AuthError::WrongAudience);
        }
        if !current.scopes.contains(TOKENS_MANAGE) {
            return Err(AuthError::MissingScope);
        }
        let current = state.tokens.remove(token_index);
        let replacement = AccessToken {
            value: replacement_value,
            audience: current.audience,
            scopes: current.scopes,
            expires_at: now
                .checked_add(self.token_ttl)
                .ok_or(AuthError::InvalidTtl)?,
        };
        state.tokens.push(replacement.clone());
        Ok(replacement)
    }

    pub fn revoke(&self, value: &str) -> Result<(), AuthError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuthError::AuthorityUnavailable)?;
        state.tokens.retain(|token| !secret_eq(&token.value, value));
        Ok(())
    }

    fn expiration(&self) -> Result<SystemTime, AuthError> {
        self.clock
            .now()
            .checked_add(self.pairing_ttl)
            .ok_or(AuthError::InvalidTtl)
    }
}

fn scope_set(scopes: &[&str]) -> BTreeSet<String> {
    scopes.iter().map(|scope| (*scope).to_owned()).collect()
}

fn secret_position<T>(items: &[T], value: &str, field: impl Fn(&T) -> &str) -> Option<usize> {
    let mut found = None;
    for (index, item) in items.iter().enumerate() {
        if secret_eq(field(item), value) {
            found = Some(index);
        }
    }
    found
}

fn secret_eq(left: &str, right: &str) -> bool {
    bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn random_hex<const N: usize>() -> Result<String, AuthError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| AuthError::EntropyUnavailable)?;
    let mut encoded = String::with_capacity(N * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(encoded)
}
