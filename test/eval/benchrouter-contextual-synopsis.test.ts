import { describe, expect, test } from 'bun:test';

describe('BenchRouter contextual synopsis fixture validation', () => {
  test('validates all modes, grounded query coverage, and natural chunk bounds offline', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'eval/runner/benchrouter-contextual-synopsis.ts', '--validate'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(stderr).toContain('[cat26] validate ok');
    expect(stderr).toContain('queries: 35');
    expect(stderr).toContain('modes: none,title,per_chunk_synopsis');
    expect(stderr).toContain('total chunks: 30');
    expect(stderr).toContain('primary_metric: mrr');
  });
});
