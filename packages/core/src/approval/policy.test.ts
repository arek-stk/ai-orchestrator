import { describe, expect, it } from 'vitest';
import { defaultApprovalGates } from '../domain/project';
import { detectGatedActions, requiresApproval, requiresCostApproval } from './policy';

describe('detectGatedActions', () => {
  const opts = { criticalPaths: ['payments/**'] };

  it('detects migrations and destructive SQL', () => {
    const gates = detectGatedActions(
      [{ path: 'db/migrations/0003_drop_legacy.sql', action: 'create', content: 'DROP TABLE legacy_orders;' }],
      opts,
    );
    expect(gates.map((g) => g.action).sort()).toEqual(['database_migration', 'destructive_data']);
  });

  it('detects conditioned full-table deletes', () => {
    const gates = detectGatedActions([{ path: 'scripts/cleanup.ts', action: 'create', content: 'await db.execute("DELETE FROM users WHERE 1=1")' }], opts);
    expect(gates.map((g) => g.action)).toEqual(['destructive_data']);
  });

  it('detects infrastructure, critical paths and secrets', () => {
    const gates = detectGatedActions(
      [
        { path: '.github/workflows/deploy.yml', action: 'update', content: 'on: push' },
        { path: 'payments/stripe.ts', action: 'update', content: 'export {}' },
        { path: 'src/config.ts', action: 'update', content: `const token = "ghp_${'b'.repeat(36)}";` },
      ],
      opts,
    );
    const byAction = Object.fromEntries(gates.map((g) => [g.action, g.paths]));
    expect(byAction.critical_infrastructure).toEqual(['.github/workflows/deploy.yml', 'payments/stripe.ts']);
    expect(byAction.secrets_permissions).toEqual(['src/config.ts']);
  });

  it('flags large change sets as architecture changes', () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({ path: `src/m${i}.ts`, action: 'update' as const, content: 'x' }));
    expect(detectGatedActions(changes, opts).map((g) => g.action)).toEqual(['architecture_change']);
  });

  it('does not flag ordinary source edits', () => {
    expect(detectGatedActions([{ path: 'src/cart.ts', action: 'update', content: 'export const x = 1;' }], opts)).toEqual([]);
  });
});

describe('approval requirements', () => {
  it('always gates production deploys below level 4', () => {
    const gates = { ...defaultApprovalGates(), production_deploy: false };
    expect(requiresApproval({ action: 'production_deploy', autonomyLevel: 3, gates })).toBe(true);
    expect(requiresApproval({ action: 'production_deploy', autonomyLevel: 4, gates })).toBe(false);
  });

  it('follows project gate configuration otherwise', () => {
    const gates = { ...defaultApprovalGates(), database_migration: false };
    expect(requiresApproval({ action: 'database_migration', autonomyLevel: 2, gates })).toBe(false);
    expect(requiresApproval({ action: 'architecture_change', autonomyLevel: 4, gates })).toBe(true);
  });

  it('gates expensive operations', () => {
    expect(requiresCostApproval(3, 2, defaultApprovalGates())).toBe(true);
    expect(requiresCostApproval(1, 2, defaultApprovalGates())).toBe(false);
  });
});
