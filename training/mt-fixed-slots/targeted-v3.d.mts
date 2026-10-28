import type {QualityCase} from '../../eval/mt-quality/protocol';

export interface SlotContract {slot: number; required: string[]}
export interface CurriculumCase extends QualityCase {
  semantic_contract: string;
  reference_repaired?: boolean;
  slot_contracts?: SlotContract[];
}
export declare function targetedCases(): CurriculumCase[];
export declare function assertSlotOwnership(sample: Pick<CurriculumCase, 'id' | 'family' | 'reference_slots' | 'slot_contracts'>): void;
export declare const repairedFamilies: string[];
export declare const trainTemplates: Array<{name: string; contract: string}>;
export declare const validationTemplates: typeof trainTemplates;
