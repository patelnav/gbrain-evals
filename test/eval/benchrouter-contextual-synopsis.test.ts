import { describe, expect, test } from 'bun:test';

function validate(extraArgs: string[]): { exitCode: number; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ['bun', 'eval/runner/benchrouter-contextual-synopsis.ts', '--validate', ...extraArgs],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
}

describe('BenchRouter contextual synopsis fixture validation', () => {
  test('validates the amara-life-v1 eval pack, label completeness, and call budget offline', () => {
    const { exitCode, stderr } = validate([]);
    expect(stderr).toContain('[contextual-synopsis:amara-life-v1] validate ok');
    expect(exitCode).toBe(0);
    expect(stderr).toContain('corpus pages: 424');
    expect(stderr).toContain('queries: 93 (110 unique gold pages)');
    expect(stderr).toContain('modes: none,title,per_chunk_synopsis');
    expect(stderr).toContain('total chunks: 424');
    expect(stderr).toContain('eval-pack max_model_calls: 480');
    expect(stderr).toContain('primary_metric: recall_at_5');
  });

  test('keeps the historical cat26 fixture valid for local reproduction', () => {
    const { exitCode, stderr } = validate(['--corpus', 'cat26']);
    expect(stderr).toContain('[contextual-synopsis:cat26] validate ok');
    expect(exitCode).toBe(0);
    expect(stderr).toContain('queries: 35');
    expect(stderr).toContain('total chunks: 30');
  });
});
