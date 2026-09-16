import type { UserRole } from '../domain/enums';

// The per-project access rule of ADR-022 as a pure function, shared by the server ACL, notification routing and the
// decision-time checks of remote approvals, so nobody is notified about (or decides on) a project they cannot see.

export type ProjectAclMode = 'enforced' | 'off';

export const ROLE_RANK: Readonly<Record<UserRole, number>> = Object.freeze({ viewer: 0, operator: 1, admin: 2, owner: 3 });

export function roleAtLeast(role: UserRole | null | undefined, minimum: UserRole): boolean {
  return role !== null && role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function lowerRole(a: UserRole, b: UserRole): UserRole {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/**
 * Effective role of a user on a project, or null when the project is not visible to them.
 * Owners and admins see every project with their global role; with `PROJECT_ACL=off` everybody does. Operators and
 * viewers need a membership and get the lower of their global and membership role.
 */
export function effectiveProjectRole(mode: ProjectAclMode, globalRole: UserRole, membershipRole: UserRole | null | undefined): UserRole | null {
  if (mode === 'off' || ROLE_RANK[globalRole] >= ROLE_RANK.admin) return globalRole;
  if (!membershipRole) return null;
  return lowerRole(globalRole, membershipRole);
}
