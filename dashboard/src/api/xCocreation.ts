import type { XSearchAuthModeV2, XSearchStatusV2 } from "./types";

export interface XCocreationVariantV1 {
  label: "A" | "B" | "C";
  body: string;
  first_reply: string;
}

export interface XCocreationDraftV1 {
  draft_id: string;
  artifact: {
    schema_version: 1;
    category: "开发判断" | "一手动态" | "失败复盘";
    title: string;
    evidence_ids: string[];
    variants: XCocreationVariantV1[];
    image_directions: string[];
    public_run_refs: string[];
    manual_weekly_summary: string;
    language: string;
  };
  artifact_hash: string;
  state: "draft" | "published" | "discarded";
  final_body: string | null;
  final_reply: string | null;
  final_url: string | null;
  created_at: string;
  updated_at: string;
  publication_verification?: "not_published" | "user_recorded";
}

export interface XCocreationSettingsV1 {
  enabled: boolean;
  topics_and_accounts: string;
  daily_time: string;
  weekly_time: string;
  provider_profile_id: string;
  automation_enabled: boolean;
  auth_mode?: XSearchAuthModeV2;
}

export interface XCocreationWorkspaceV1 {
  drafts: XCocreationDraftV1[];
  status: XSearchStatusV2;
  auth_mode: XSearchAuthModeV2;
  settings: XCocreationSettingsV1 | null;
}

export interface XCocreationComposeInputV1 {
  provider_profile_id: string;
  weekly_summary: string;
  language: string;
}

export interface XCocreationPublicationInputV1 {
  final_body: string;
  final_reply: string;
  final_url?: string;
  difference_kinds: Array<"opening" | "length" | "tone" | "remove_numbers" | "cta" | "image">;
  expected_updated_at: string;
}
