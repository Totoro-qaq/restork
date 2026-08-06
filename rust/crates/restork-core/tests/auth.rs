use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use restork_core::auth::{
    Audience, AuthError, CHECKPOINTS_RESTORE, CLI_SCOPES, Clock, DELIVERABLES_EXPORT,
    EXTENSIONS_MANAGE, PROMPTS_MANAGE, PairingAuthority, RUNS_READ, RUNS_WRITE, SCHEDULES_MANAGE,
    SESSIONS_DELETE, TOKENS_MANAGE, TOOLS_INVOKE, WEB_SCOPES,
};

#[derive(Debug)]
struct TestClock(Mutex<SystemTime>);

impl TestClock {
    fn new(now: SystemTime) -> Self {
        Self(Mutex::new(now))
    }

    fn advance(&self, duration: Duration) {
        let mut now = self.0.lock().expect("clock lock");
        *now = now.checked_add(duration).expect("fixture time");
    }
}

impl Clock for TestClock {
    fn now(&self) -> SystemTime {
        *self.0.lock().expect("clock lock")
    }
}

fn scopes(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn pairing_is_single_use_audience_bound_scope_bound_and_redacted() {
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    assert_eq!(code.len(), 48);

    let token = authority.pair(&code, Audience::Web).expect("pair once");
    assert_eq!(token.value().len(), 64);
    assert_eq!(token.audience(), Audience::Web);
    assert_eq!(token.scopes(), &scopes(WEB_SCOPES));
    assert_eq!(
        authority.verify(token.value(), &[Audience::Web], &[RUNS_READ]),
        Ok(token.clone())
    );
    assert_eq!(
        authority.pair(&code, Audience::Web),
        Err(AuthError::InvalidPairingCode)
    );
    assert_eq!(
        authority.verify(token.value(), &[Audience::Cli], &[RUNS_READ]),
        Err(AuthError::WrongAudience)
    );

    assert!(!format!("{token:?}").contains(token.value()));
    assert!(!format!("{authority:?}").contains(&code));

    let limited_code = authority
        .new_pairing_code(Audience::Web, &[RUNS_READ])
        .expect("limited challenge");
    let limited = authority
        .pair(&limited_code, Audience::Web)
        .expect("limited token");
    assert_eq!(
        authority.verify(limited.value(), &[Audience::Web], &[RUNS_WRITE]),
        Err(AuthError::MissingScope)
    );
}

/// A pairing code offered to the wrong client survives for its own client.
///
/// This deliberately replaces the previous fail-closed stance, under which a
/// misdirected code was burned. That stance bought almost nothing: it only
/// helps against an attacker who holds the code but cannot guess its audience,
/// and the audience is not a secret — Core prints it on the same line as the
/// code. Meanwhile it made one plausible copy-and-paste mistake permanently
/// destroy the Web pairing code, after which the browser could never pair and
/// the only recovery was restarting Core, which nothing told the user.
///
/// An expired code is still consumed; see `expired_challenge_is_consumed`.
#[test]
fn wrong_audience_preserves_the_challenge_for_its_own_client() {
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority
        .new_pairing_code(Audience::Cli, CLI_SCOPES)
        .expect("CLI challenge");

    assert_eq!(
        authority.pair(&code, Audience::Web),
        Err(AuthError::PairingWrongAudience)
    );

    // The mistake must not have cost the user their pairing code.
    let token = authority
        .pair(&code, Audience::Cli)
        .expect("the CLI code still pairs its own client after a misdirected attempt");
    assert_eq!(token.audience(), Audience::Cli);

    // It remains single-use.
    assert_eq!(
        authority.pair(&code, Audience::Cli),
        Err(AuthError::InvalidPairingCode)
    );
}

/// An expired code is consumed even though a wrong-audience one is not: it can
/// never succeed again, so leaving it in place would only let a dead code be
/// retried indefinitely.
#[test]
fn expired_challenge_is_consumed() {
    let clock = Arc::new(TestClock::new(SystemTime::UNIX_EPOCH));
    let authority = PairingAuthority::with_clock(Duration::from_secs(300), Arc::clone(&clock))
        .expect("authority");
    let code = authority
        .new_pairing_code(Audience::Web, WEB_SCOPES)
        .expect("web challenge");

    clock.advance(Duration::from_secs(301));

    assert_eq!(
        authority.pair(&code, Audience::Web),
        Err(AuthError::ExpiredPairingCode)
    );
    assert_eq!(
        authority.pair(&code, Audience::Web),
        Err(AuthError::InvalidPairingCode)
    );
}

/// Pairing codes and access tokens are transcribed and renewed on completely
/// different schedules, so one TTL cannot serve both. Governing both with a
/// single 300-second value made the CLI unusable five minutes after pairing.
#[test]
fn pairing_and_token_lifetimes_are_independent() {
    let clock = Arc::new(TestClock::new(SystemTime::UNIX_EPOCH));
    let authority = PairingAuthority::with_ttls_and_clock(
        Duration::from_secs(900),
        Duration::from_secs(60),
        Arc::clone(&clock),
    )
    .expect("authority");
    let code = authority
        .new_pairing_code(Audience::Web, WEB_SCOPES)
        .expect("web challenge");

    // Past the token lifetime, well inside the pairing lifetime.
    clock.advance(Duration::from_secs(120));
    let token = authority
        .pair(&code, Audience::Web)
        .expect("a code within its own lifetime still pairs");

    assert!(
        authority
            .verify(token.value(), &[Audience::Web], &[])
            .is_ok()
    );
    clock.advance(Duration::from_secs(61));
    assert_eq!(
        authority.verify(token.value(), &[Audience::Web], &[]),
        Err(AuthError::InvalidOrExpiredToken)
    );
}

#[test]
fn rotation_revocation_and_expiry_are_fail_closed() {
    let clock = Arc::new(TestClock::new(SystemTime::UNIX_EPOCH));
    let authority =
        PairingAuthority::with_clock(Duration::from_secs(60), clock.clone()).expect("authority");
    let code = authority
        .new_pairing_code(Audience::Cli, CLI_SCOPES)
        .expect("CLI challenge");
    let token = authority.pair(&code, Audience::Cli).expect("CLI token");
    assert!(token.scopes().contains(TOKENS_MANAGE));

    let replacement = authority
        .rotate(token.value(), &[Audience::Cli])
        .expect("rotate");
    assert_eq!(
        authority.verify(token.value(), &[Audience::Cli], &[]),
        Err(AuthError::InvalidOrExpiredToken)
    );
    authority.revoke(replacement.value()).expect("revoke");
    assert_eq!(
        authority.verify(replacement.value(), &[Audience::Cli], &[]),
        Err(AuthError::InvalidOrExpiredToken)
    );

    let expiring_code = authority
        .new_pairing_code(Audience::Cli, CLI_SCOPES)
        .expect("challenge");
    let expiring = authority
        .pair(&expiring_code, Audience::Cli)
        .expect("token");
    clock.advance(Duration::from_secs(61));
    assert_eq!(
        authority.verify(expiring.value(), &[Audience::Cli], &[]),
        Err(AuthError::InvalidOrExpiredToken)
    );
}

#[test]
fn rotation_grace_recovers_suspended_clients_but_remains_bounded() {
    let clock = Arc::new(TestClock::new(SystemTime::UNIX_EPOCH));
    let authority =
        PairingAuthority::with_clock(Duration::from_secs(60), clock.clone()).expect("authority");
    let token = authority
        .pair(&authority.initial_pairing_code(), Audience::Web)
        .expect("Web token");

    clock.advance(Duration::from_secs(61));
    let recovered = authority
        .rotate_with_grace(token.value(), &[Audience::Web], Duration::from_secs(300))
        .expect("recover within grace");
    assert_eq!(recovered.audience(), Audience::Web);
    assert_eq!(
        authority.verify(token.value(), &[Audience::Web], &[]),
        Err(AuthError::InvalidOrExpiredToken)
    );

    clock.advance(Duration::from_secs(361));
    assert_eq!(
        authority.rotate_with_grace(
            recovered.value(),
            &[Audience::Web],
            Duration::from_secs(300),
        ),
        Err(AuthError::InvalidOrExpiredToken)
    );
}

#[test]
fn invalid_ttl_and_capability_escalation_are_rejected() {
    assert!(matches!(
        PairingAuthority::new(Duration::ZERO),
        Err(AuthError::InvalidTtl)
    ));
    let authority = PairingAuthority::new(Duration::from_secs(60)).expect("authority");
    assert_eq!(
        authority.new_pairing_code(Audience::Web, &["shell:root"]),
        Err(AuthError::ScopeEscalation)
    );
    assert_eq!(
        authority.new_pairing_code(Audience::Web, &[]),
        Err(AuthError::ScopeEscalation)
    );
}

#[test]
fn post_v1_capabilities_are_explicit_and_limited_tokens_cannot_cross_domains() {
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    for required in [
        SESSIONS_DELETE,
        PROMPTS_MANAGE,
        EXTENSIONS_MANAGE,
        TOOLS_INVOKE,
        DELIVERABLES_EXPORT,
        SCHEDULES_MANAGE,
        CHECKPOINTS_RESTORE,
    ] {
        assert!(WEB_SCOPES.contains(&required), "missing scope {required}");
    }

    let code = authority
        .new_pairing_code(Audience::Web, &[SESSIONS_DELETE])
        .expect("single-purpose pairing code");
    let token = authority
        .pair(&code, Audience::Web)
        .expect("single-purpose token");
    assert_eq!(
        authority.verify(token.value(), &[Audience::Web], &[SESSIONS_DELETE]),
        Ok(token.clone())
    );
    assert_eq!(
        authority.verify(token.value(), &[Audience::Web], &[PROMPTS_MANAGE]),
        Err(AuthError::MissingScope)
    );
}
