//! Deterministic evidence hashing, chunking, and claim binding.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_CHUNK_CHARS: usize = 1_600;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvidenceChunk {
    pub evidence_id: String,
    pub source_ref: String,
    pub ordinal: usize,
    pub content: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ClaimBinding {
    pub claim_id: String,
    pub statement: String,
    pub evidence_refs: Vec<String>,
    pub grounded: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EvidenceLedger {
    pub chunks: Vec<EvidenceChunk>,
    pub claims: Vec<ClaimBinding>,
    pub unresolved_references: Vec<String>,
}

pub fn chunk_source(source_ref: &str, content: &str) -> Vec<EvidenceChunk> {
    let mut chunks = Vec::new();
    let mut buffer = String::new();
    for paragraph in content.split("\n\n") {
        if !buffer.is_empty()
            && buffer.chars().count() + paragraph.chars().count() > MAX_CHUNK_CHARS
        {
            push_chunk(source_ref, &mut chunks, std::mem::take(&mut buffer));
        }
        if paragraph.chars().count() > MAX_CHUNK_CHARS {
            for slice in char_chunks(paragraph, MAX_CHUNK_CHARS) {
                push_chunk(source_ref, &mut chunks, slice);
            }
        } else {
            if !buffer.is_empty() {
                buffer.push_str("\n\n");
            }
            buffer.push_str(paragraph);
        }
    }
    if !buffer.trim().is_empty() {
        push_chunk(source_ref, &mut chunks, buffer);
    }
    chunks
}

pub fn build_ledger(
    sources: impl IntoIterator<Item = (String, String)>,
    claims: impl IntoIterator<Item = (String, String, Vec<String>)>,
) -> EvidenceLedger {
    let mut unique = BTreeMap::<String, EvidenceChunk>::new();
    for (source_ref, content) in sources {
        for chunk in chunk_source(&source_ref, &content) {
            unique.entry(chunk.content_hash.clone()).or_insert(chunk);
        }
    }
    let available = unique
        .values()
        .map(|chunk| chunk.evidence_id.clone())
        .collect::<BTreeSet<_>>();
    let by_source = unique.values().fold(
        BTreeMap::<String, Vec<String>>::new(),
        |mut index, chunk| {
            index
                .entry(chunk.source_ref.clone())
                .or_default()
                .push(chunk.evidence_id.clone());
            index
        },
    );
    let mut unresolved = BTreeSet::new();
    let claims = claims
        .into_iter()
        .map(|(claim_id, statement, evidence_refs)| {
            let mut valid = Vec::new();
            for reference in evidence_refs {
                if available.contains(&reference) {
                    valid.push(reference);
                } else if let Some(chunks) = by_source.get(&reference) {
                    valid.extend(chunks.iter().cloned());
                } else {
                    unresolved.insert(reference);
                }
            }
            ClaimBinding {
                claim_id,
                statement,
                grounded: !valid.is_empty(),
                evidence_refs: valid,
            }
        })
        .collect();
    EvidenceLedger {
        chunks: unique.into_values().collect(),
        claims,
        unresolved_references: unresolved.into_iter().collect(),
    }
}

fn push_chunk(source_ref: &str, chunks: &mut Vec<EvidenceChunk>, content: String) {
    let content = content.trim().to_owned();
    if content.is_empty() {
        return;
    }
    let content_hash = hash(content.as_bytes());
    let ordinal = chunks.len();
    chunks.push(EvidenceChunk {
        evidence_id: format!("ev-{}", &content_hash[..24]),
        source_ref: source_ref.to_owned(),
        ordinal,
        content,
        content_hash,
    });
}

fn char_chunks(value: &str, maximum: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if current.chars().count() >= maximum {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{build_ledger, chunk_source};

    #[test]
    fn chunks_are_hashed_deduplicated_and_claims_cannot_bind_missing_evidence() {
        let chunks = chunk_source("source-a", "one\n\ntwo");
        let valid = chunks[0].evidence_id.clone();
        let ledger = build_ledger(
            [
                ("source-a".to_owned(), "one\n\ntwo".to_owned()),
                ("source-b".to_owned(), "one\n\ntwo".to_owned()),
            ],
            [(
                "claim-1".to_owned(),
                "statement".to_owned(),
                vec![valid, "missing".to_owned()],
            )],
        );
        assert_eq!(ledger.chunks.len(), 1);
        assert!(ledger.claims[0].grounded);
        assert_eq!(ledger.unresolved_references, vec!["missing"]);
    }
}
