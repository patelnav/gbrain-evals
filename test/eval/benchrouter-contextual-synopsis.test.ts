import { describe, expect, test } from 'bun:test';
import {
  loadEvalPack,
  loadFixture,
  validateChunkBudget,
  validateStaticInputs,
} from '../../eval/runner/benchrouter-contextual-synopsis.ts';

describe('BenchRouter contextual synopsis fixture validation', () => {
  test('amara-life-v1 eval pack, input refs, and label completeness validate offline', () => {
    const pack = loadEvalPack();
    const fixture = loadFixture('amara-life-v1');
    expect(pack.primary_metric).toBe('recall_at_5');
    expect(fixture.pages.length).toBe(424);
    expect(fixture.queries.length).toBe(93);
    expect(new Set(fixture.queries.flatMap(q => q.relevant_slugs)).size).toBe(110);
    expect(() => validateStaticInputs(pack, fixture, false)).not.toThrow();
    expect(() => validateStaticInputs(pack, fixture, true)).not.toThrow();
  });

  test('a missing label fails the evidence check', () => {
    const pack = loadEvalPack();
    const fixture = loadFixture('amara-life-v1');
    const conflict = fixture.queries.find(q => q.id === 'conflict-meridian-solar-series-a')!;
    conflict.relevant_slugs = conflict.relevant_slugs.slice(0, 1);
    expect(() => validateStaticInputs(pack, fixture, false)).toThrow('labels disagree with its evidence');
  });

  test('amara-life-v1 imports as 424 single-chunk pages within the call budget', async () => {
    const pack = loadEvalPack();
    const stats = await validateChunkBudget(pack, loadFixture('amara-life-v1'));
    expect(stats.totalChunks).toBe(424);
    expect(pack.max_model_calls).toBeGreaterThanOrEqual(stats.totalChunks);
  });

  test('the historical cat26 fixture stays valid for local reproduction', async () => {
    const pack = loadEvalPack();
    const fixture = loadFixture('cat26');
    validateStaticInputs(pack, fixture, false);
    const stats = await validateChunkBudget(pack, fixture);
    expect(fixture.queries.length).toBe(35);
    expect(stats.totalChunks).toBe(30);
  });
});
