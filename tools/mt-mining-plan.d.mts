import type {QualityCase} from "../eval/mt-quality/protocol";
export function trainingMiningCases(): QualityCase[];
export function exportMiningPlan(output: string): Promise<{cases:number; jobs:number; source_training_only:boolean; grammar_applied:boolean; optimizer_executed:boolean}>;
