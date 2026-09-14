import type { FastifyRequest } from 'fastify';
import type { AnyDomainEvent, UserRole } from '@orch/core';
import type { AdminRepositories, SessionUser } from '@orch/db';

// Per-project access control (ADR-022). Owners and admins see every project; operators and viewers only see
// projects they are members of, with the lower of their global role and their membership role.

export type ProjectAclMode = 'enforced' | 'off';

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
/** Upper bound for memberships considered per user (keeps per-project fan-out queries bounded). */
export const MAX_MEMBERSHIPS = 500;

export class ProjectAccessError extends Error {
  constructor(
    readonly statusCode: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectAccessError';
  }
}

export function lowerRole(a: UserRole, b: UserRole): UserRole {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/** null = every project is visible. */
export type VisibleProjects = ReadonlyMap<string, UserRole> | null;

export function eventVisible(visible: VisibleProjects, event: Pick<AnyDomainEvent, 'projectId'>): boolean {
  if (visible === null) return true;
  // Events without a project are system-wide; restricted users do not need them (deny by default).
  return event.projectId !== null && visible.has(event.projectId);
}

export interface ScopedListOptions<T> {
  limit: number;
  /** Sort key, larger = first (e.g. a timestamp or numeric id). */
  sortKey: (item: T) => number;
  order?: 'asc' | 'desc';
}

export interface ProjectAcl {
  readonly mode: ProjectAclMode;
  /**
   * Memberships of the request's user (cached per request unless `fresh`, used by long-lived SSE streams);
   * null when every project is visible.
   */
  visibleProjects(request: FastifyRequest, options?: { fresh?: boolean }): Promise<VisibleProjects>;
  /** Throws 404 when the project is not visible, 403 when the effective project role is below `minimum`. */
  assertProject(request: FastifyRequest, projectId: string, minimum?: UserRole, entity?: string): Promise<void>;
  /**
   * Lists records across the projects visible to the user. With `projectId` the access is asserted and the fetch is
   * scoped; for unrestricted users the unscoped fetch is used; otherwise per-project results are merged.
   */
  scopedList<T>(request: FastifyRequest, projectId: string | undefined, fetch: (projectId?: string) => Promise<T[]>, options: ScopedListOptions<T>): Promise<T[]>;
}

export function createProjectAcl(mode: ProjectAclMode, admin: Pick<AdminRepositories, 'members'>): ProjectAcl {
  const cache = new WeakMap<FastifyRequest, Promise<VisibleProjects>>();

  const unrestricted = (user: SessionUser | null) => mode === 'off' || (user !== null && ROLE_RANK[user.role] >= ROLE_RANK.admin);

  const load = async (user: SessionUser | null): Promise<VisibleProjects> => {
    if (unrestricted(user)) return null;
    if (!user) return new Map();
    const memberships = await admin.members.listForUser(user.id, MAX_MEMBERSHIPS);
    return new Map(memberships.map((m) => [m.projectId, lowerRole(user.role, m.role)]));
  };

  const visibleProjects = (request: FastifyRequest, options: { fresh?: boolean } = {}): Promise<VisibleProjects> => {
    let pending = options.fresh ? undefined : cache.get(request);
    if (!pending) {
      pending = load(request.user);
      cache.set(request, pending);
    }
    return pending;
  };

  return {
    mode,
    visibleProjects,

    async assertProject(request, projectId, minimum = 'viewer', entity = 'project') {
      const visible = await visibleProjects(request);
      if (visible === null) return;
      const role = visible.get(projectId);
      if (role === undefined) throw new ProjectAccessError(404, `${entity} not found`);
      if (ROLE_RANK[role] < ROLE_RANK[minimum]) throw new ProjectAccessError(403, `requires the ${minimum} role on this project`);
    },

    async scopedList(request, projectId, fetch, options) {
      if (projectId !== undefined) {
        await this.assertProject(request, projectId);
        return fetch(projectId);
      }
      const visible = await visibleProjects(request);
      if (visible === null) return fetch(undefined);
      const lists = await Promise.all([...visible.keys()].map((id) => fetch(id)));
      const direction = options.order === 'asc' ? 1 : -1;
      return lists
        .flat()
        .sort((a, b) => direction * (options.sortKey(a) - options.sortKey(b)))
        .slice(0, options.limit);
    },
  };
}
