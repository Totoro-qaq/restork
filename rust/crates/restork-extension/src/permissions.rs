use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize, de};

use crate::{ExtensionError, validation::validate_identifier};

/// One namespaced authority such as `network:papers` or `vault:read`.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Permission(String);

impl Permission {
    pub fn parse(value: impl Into<String>) -> Result<Self, ExtensionError> {
        let value = value.into();
        validate_identifier(&value)?;
        if !value.contains(':') {
            return Err(ExtensionError::InvalidIdentifier(value));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Permission {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// Deterministically ordered permission collection.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PermissionSet(BTreeSet<Permission>);

impl PermissionSet {
    pub fn from_ids<I, S>(values: I) -> Result<Self, ExtensionError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        values
            .into_iter()
            .map(|value| Permission::parse(value.into()))
            .collect::<Result<BTreeSet<_>, _>>()
            .map(Self)
    }

    #[must_use]
    pub fn contains(&self, permission: &Permission) -> bool {
        self.0.contains(permission)
    }

    #[must_use]
    pub fn contains_id(&self, permission: &str) -> bool {
        self.0
            .iter()
            .any(|candidate| candidate.as_str() == permission)
    }

    #[must_use]
    pub fn is_subset(&self, other: &Self) -> bool {
        self.0.is_subset(&other.0)
    }

    #[must_use]
    pub fn intersection(&self, other: &Self) -> Self {
        Self(self.0.intersection(&other.0).cloned().collect())
    }

    #[must_use]
    pub fn difference(&self, other: &Self) -> Self {
        Self(self.0.difference(&other.0).cloned().collect())
    }

    #[must_use]
    pub fn has_namespace(&self, namespace: &str) -> bool {
        self.0
            .iter()
            .any(|permission| permission.as_str().starts_with(namespace))
    }

    pub fn iter(&self) -> impl Iterator<Item = &Permission> {
        self.0.iter()
    }
}

impl FromIterator<Permission> for PermissionSet {
    fn from_iter<T: IntoIterator<Item = Permission>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

/// Result of `Core ceiling ∩ Profile ∩ Package request ∩ Run grant`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectiveGrant {
    granted: PermissionSet,
    denied_from_package: PermissionSet,
}

impl EffectiveGrant {
    #[must_use]
    pub const fn granted(&self) -> &PermissionSet {
        &self.granted
    }

    #[must_use]
    pub const fn denied_from_package(&self) -> &PermissionSet {
        &self.denied_from_package
    }
}

#[must_use]
pub fn resolve_effective_grant(
    core_ceiling: &PermissionSet,
    profile_grant: &PermissionSet,
    package_request: &PermissionSet,
    run_grant: &PermissionSet,
) -> EffectiveGrant {
    let granted = core_ceiling
        .intersection(profile_grant)
        .intersection(package_request)
        .intersection(run_grant);
    EffectiveGrant {
        denied_from_package: package_request.difference(&granted),
        granted,
    }
}
