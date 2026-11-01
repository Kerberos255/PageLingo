import type {QualityCase} from "../../eval/mt-quality/protocol";
export interface PreferenceCase extends QualityCase {
  rejected_slots: string[];
  semantic_contract: string;
  rejected_error: string;
  semantic_checks: {slot: number; chosen: string; rejected: string}[];
}
export function preferenceCases(): PreferenceCase[];
export function assertPreferenceReference(sample: PreferenceCase): void;
