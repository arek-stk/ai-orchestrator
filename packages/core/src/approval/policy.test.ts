import { describe, expect, it } from 'vitest';
import type { AutonomyLevel } from '../domain/enums';
import { defaultApprovalGates, defaultProjectSettings, GATED_ACTIONS, HARD_GATED_ACTIONS, ProjectSettingsSchema, type GatedAction } from '../domain/project';
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

  it('treats a gate missing from an older configuration as enabled', () => {
    const { database_migration: _removed, ...rest } = defaultApprovalGates();
    expect(requiresApproval({ action: 'database_migration', autonomyLevel: 4, gates: rest as Record<GatedAction, boolean> })).toBe(true);
  });
});

describe('dependency_addition hard rule (ADR-031)', () => {
  const LEVELS: readonly AutonomyLevel[] = [0, 1, 2, 3, 4];

  it('requires approval at every autonomy level although the gate is disabled in the project config', () => {
    const disabled = { ...defaultApprovalGates(), dependency_addition: false };
    const everythingOff = Object.fromEntries(GATED_ACTIONS.map((action) => [action, false])) as Record<GatedAction, boolean>;
    for (const autonomyLevel of LEVELS) {
      expect(requiresApproval({ action: 'dependency_addition', autonomyLevel, gates: disabled })).toBe(true);
      expect(requiresApproval({ action: 'dependency_addition', autonomyLevel, gates: everythingOff })).toBe(true);
    }
    // Unlike production_deploy there is no level exception.
    expect(requiresApproval({ action: 'production_deploy', autonomyLevel: 4, gates: everythingOff })).toBe(false);
    expect(HARD_GATED_ACTIONS).toEqual(['dependency_addition']);
  });

  it('cannot be switched off through validated project settings', () => {
    const settings = defaultProjectSettings();
    expect(settings.approvalGates.dependency_addition).toBe(true);
    expect(ProjectSettingsSchema.safeParse(settings).success).toBe(true);
    const attempt = ProjectSettingsSchema.safeParse({ ...settings, approvalGates: { ...settings.approvalGates, dependency_addition: false } });
    expect(attempt.success).toBe(false);
    expect(attempt.error!.issues[0]!.message).toMatch(/cannot be disabled/);
  });
});
