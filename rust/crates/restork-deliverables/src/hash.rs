use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{DeliverableError, Result};

pub(crate) fn canonical_hash<T>(value: &T) -> Result<String>
where
    T: Serialize + ?Sized,
{
    let bytes = serde_json::to_vec(value)
        .map_err(|error| DeliverableError::Serialization(error.to_string()))?;
    Ok(sha256_hex(&bytes))
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    encode_hex(&Sha256::digest(bytes))
}

pub(crate) fn domain_hash(domain: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    append_part(&mut hasher, domain.as_bytes());
    for part in parts {
        append_part(&mut hasher, part.as_bytes());
    }
    encode_hex(&hasher.finalize())
}

pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

fn append_part(hasher: &mut Sha256, part: &[u8]) {
    hasher.update((part.len() as u64).to_be_bytes());
    hasher.update(part);
}
