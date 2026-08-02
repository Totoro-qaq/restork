use std::{error::Error, fmt};

/// Fail-closed validation and resolution errors for extension metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtensionError {
    InvalidSchemaVersion,
    InvalidIdentifier(String),
    InvalidVersion(String),
    InvalidReference(String),
    InvalidHash,
    InvalidLicense,
    InvalidSignature,
    InvalidPinnedSource,
    InvalidCompatibility,
    DuplicateIdentifier(String),
    HiddenPermission(String),
    InvalidSecretReference,
    InvalidSandbox,
    InvalidExecutable,
    ShellExecutableDenied,
    ShellInterpolationDenied,
    DynamicNpxDenied,
    EnvironmentInheritanceDenied,
    InvalidEnvironment,
    InvalidRemoteEndpoint,
    UnsafeUiContribution,
    PackageIdentityChanged,
    UnknownTool(String),
    InvalidToolInput,
    InvalidSearch,
}

impl fmt::Display for ExtensionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSchemaVersion => {
                formatter.write_str("unsupported extension schema version")
            }
            Self::InvalidIdentifier(value) => write!(formatter, "invalid identifier `{value}`"),
            Self::InvalidVersion(value) => write!(formatter, "invalid version `{value}`"),
            Self::InvalidReference(value) => {
                write!(formatter, "invalid resource reference `{value}`")
            }
            Self::InvalidHash => formatter.write_str("invalid SHA-256 digest"),
            Self::InvalidLicense => formatter.write_str("invalid SPDX-style license expression"),
            Self::InvalidSignature => formatter.write_str("invalid package signature metadata"),
            Self::InvalidPinnedSource => {
                formatter.write_str("extension source is not immutable and pinned")
            }
            Self::InvalidCompatibility => formatter.write_str("invalid Core compatibility range"),
            Self::DuplicateIdentifier(value) => write!(formatter, "duplicate identifier `{value}`"),
            Self::HiddenPermission(value) => {
                write!(
                    formatter,
                    "component requests undeclared package permission `{value}`"
                )
            }
            Self::InvalidSecretReference => formatter.write_str("invalid native secret reference"),
            Self::InvalidSandbox => formatter.write_str("invalid extension sandbox limits"),
            Self::InvalidExecutable => {
                formatter.write_str("stdio executable must be an exact absolute path")
            }
            Self::ShellExecutableDenied => {
                formatter.write_str("shell and command-wrapper executables are denied")
            }
            Self::ShellInterpolationDenied => {
                formatter.write_str("shell or template interpolation is denied")
            }
            Self::DynamicNpxDenied => formatter.write_str("dynamic npx execution is denied"),
            Self::EnvironmentInheritanceDenied => {
                formatter.write_str("ambient environment inheritance is denied")
            }
            Self::InvalidEnvironment => {
                formatter.write_str("invalid explicit environment declaration")
            }
            Self::InvalidRemoteEndpoint => {
                formatter.write_str("remote MCP endpoint must be credential-free HTTPS")
            }
            Self::UnsafeUiContribution => {
                formatter.write_str("UI contribution must be declarative and code-free")
            }
            Self::PackageIdentityChanged => {
                formatter.write_str("an update cannot change the package identifier")
            }
            Self::UnknownTool(value) => write!(
                formatter,
                "tool `{value}` is not present in the frozen session"
            ),
            Self::InvalidToolInput => {
                formatter.write_str("tool input must be a bounded JSON object")
            }
            Self::InvalidSearch => formatter.write_str("tool search query or limit is invalid"),
        }
    }
}

impl Error for ExtensionError {}
