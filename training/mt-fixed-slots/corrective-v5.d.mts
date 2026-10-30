import type {QualityCase} from "../../eval/mt-quality/protocol";
export type CorrectiveCase = QualityCase & {
  natural_reference: string;
  semantic_facts: Array<Record<string, unknown>>;
  slot_contracts: Array<{slot: number; required: string[]}>;
};
export function correctiveCases(): CorrectiveCase[];
export function assertCorrectiveReference(sample: CorrectiveCase): void;
