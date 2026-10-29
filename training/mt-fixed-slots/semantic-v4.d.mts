import type {QualityCase} from '../../eval/mt-quality/protocol';
export interface SemanticCase extends QualityCase {
  natural_reference: string;
  semantic_facts: Array<Record<string, unknown>>;
  slot_contracts: Array<{slot: number; required: string[]}>;
  contrastive_draft?: string;
}
export function semanticCases(): SemanticCase[];
export function assertDeclaredSlotContracts(sample: SemanticCase): void;
