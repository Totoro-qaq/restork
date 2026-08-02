use std::{error::Error, fmt};

/// A redaction-safe validation failure at a public contract boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractError {
    field: &'static str,
    message: String,
}

impl ContractError {
    pub(crate) fn new(field: &'static str, message: impl Into<String>) -> Self {
        Self {
            field,
            message: message.into(),
        }
    }

    /// The stable contract field associated with the failure.
    #[must_use]
    pub const fn field(&self) -> &'static str {
        self.field
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.field, self.message)
    }
}

impl Error for ContractError {}

/// Result returned by validated domain constructors.
pub type ContractResult<T> = Result<T, ContractError>;
