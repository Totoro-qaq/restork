use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    ExtensionError,
    validation::{
        contains_interpolation, is_absolute_executable, validate_https_endpoint,
        validate_identifier,
    },
};

/// Explicit environment passed to a stdio server. Ambient inheritance is never accepted.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentPolicy {
    pub inherit: bool,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
}

impl EnvironmentPolicy {
    #[must_use]
    pub fn isolated() -> Self {
        Self::default()
    }

    fn validate(&self) -> Result<(), ExtensionError> {
        if self.inherit {
            return Err(ExtensionError::EnvironmentInheritanceDenied);
        }
        for (name, value) in &self.variables {
            if name.is_empty()
                || name.len() > 96
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
                || name.as_bytes()[0].is_ascii_digit()
                || value.len() > 4096
            {
                return Err(ExtensionError::InvalidEnvironment);
            }
            if contains_interpolation(value) {
                return Err(ExtensionError::ShellInterpolationDenied);
            }
        }
        Ok(())
    }
}

/// A stdio process declaration. It is data only and never spawns the executable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StdioDefinition {
    pub executable: String,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub environment: EnvironmentPolicy,
}

impl StdioDefinition {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        if !is_absolute_executable(&self.executable)
            || self.executable.len() > 4096
            || contains_interpolation(&self.executable)
        {
            return Err(ExtensionError::InvalidExecutable);
        }
        let executable_name = self
            .executable
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            executable_name.as_str(),
            "sh" | "bash"
                | "zsh"
                | "fish"
                | "dash"
                | "cmd"
                | "cmd.exe"
                | "powershell"
                | "powershell.exe"
                | "pwsh"
                | "pwsh.exe"
                | "env"
        ) {
            return Err(ExtensionError::ShellExecutableDenied);
        }
        if self.argv.len() > 128
            || self
                .argv
                .iter()
                .any(|argument| argument.len() > 16_384 || argument.contains('\0'))
        {
            return Err(ExtensionError::InvalidExecutable);
        }
        if self
            .argv
            .iter()
            .any(|argument| contains_interpolation(argument))
        {
            return Err(ExtensionError::ShellInterpolationDenied);
        }
        if matches!(executable_name.as_str(), "npx" | "npx.cmd" | "npx.exe") {
            return Err(ExtensionError::DynamicNpxDenied);
        }
        self.environment.validate()
    }
}

/// Streamable-HTTP MCP endpoint metadata. OAuth is a reference, never a token.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteDefinition {
    pub endpoint: String,
    pub oauth_profile: Option<String>,
}

impl RemoteDefinition {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        validate_https_endpoint(&self.endpoint)?;
        if let Some(reference) = &self.oauth_profile {
            validate_identifier(reference)?;
            if !reference.starts_with("oauth:") {
                return Err(ExtensionError::InvalidSecretReference);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum McpTransport {
    Stdio(StdioDefinition),
    RemoteHttps(RemoteDefinition),
}

impl McpTransport {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        match self {
            Self::Stdio(definition) => definition.validate(),
            Self::RemoteHttps(definition) => definition.validate(),
        }
    }
}
