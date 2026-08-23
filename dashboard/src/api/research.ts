/** The research artifact contract shared by Core, the run detail view and the vault note preview. */
export interface ResearchArtifact {
  artifact_id: string;
  run_id: string;
  question: string;
  claims: Array<{
    claim_id: string;
    statement: string;
    kind: "grounded" | "inference";
    evidence_refs: string[];
    inference_basis: string | null;
  }>;
  conflicts: Array<string | { description: string; evidence_refs?: string[] }>;
  unresolved_questions: string[];
  related_notes: Array<{ relative_path: string; title: string; score: number }>;
  note_preview: {
    action: "create" | "append" | "no_change";
    relative_path: string;
    expected_hash: string | null;
    markdown: string;
    markdown_hash: string;
  };
  metrics: {
    supported_claim_rate: number;
    primary_source_ratio: number | null;
    citation_correctness: number | null;
    duplicate_sources: number;
    related_note_count: number;
    conflict_count: number;
  };
}
