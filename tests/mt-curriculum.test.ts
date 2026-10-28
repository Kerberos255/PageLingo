import {describe, expect, it} from 'vitest';
import {assertSlotOwnership, targetedCases, repairedFamilies} from '../training/mt-fixed-slots/targeted-v3.mjs';

describe('v3 source-slot ownership curriculum', () => {
  it('keeps validation failures out of training and keeps families disjoint', () => {
    const cases = targetedCases();
    expect(cases.filter(sample => sample.split === 'train')).toHaveLength(608);
    expect(cases.filter(sample => sample.split === 'validation')).toHaveLength(32);
    const train = new Set(cases.filter(sample => sample.split === 'train').map(sample => sample.family));
    expect(cases.filter(sample => sample.split === 'validation').every(sample => !train.has(sample.family))).toBe(true);
    expect(new Set(cases.map(sample => sample.html)).size).toBe(cases.length);
  });

  it('rejects moving the registration action back across protected code', () => {
    const sample = targetedCases().find(sample => sample.id === 'v3-hard-register-before-enabling-0')!;
    expect(sample.reference_slots[0]).toContain('注册报告');
    const broken = {...sample, reference_slots: ['先通过', '成功注册报告，', ...sample.reference_slots.slice(2)]};
    expect(() => assertSlotOwnership(broken)).toThrow(/source slot 0/);
  });

  it('rejects omitting one of allocate, attach and start from the lifecycle reference', () => {
    const sample = targetedCases().find(sample => sample.id === 'v3-create-bind-start-all-0')!;
    const broken = {...sample, reference_slots: sample.reference_slots.map(text => text.replace('启动执行', '执行'))};
    expect(() => assertSlotOwnership(broken)).toThrow(/source slot 1/);
  });

  it('retains noun and verb ownership for every annotated reference', () => {
    const cases = targetedCases();
    expect(repairedFamilies).toHaveLength(12);
    expect(cases.filter(sample => sample.reference_repaired)).toHaveLength(96);
    for (const sample of cases) expect(() => assertSlotOwnership(sample)).not.toThrow();
    expect(cases.find(sample => sample.id === 'v3-hard-long-order-and-bounds-0')!.reference_slots[0]).toContain('先检查已提交副本的数量');
  });
});
