import { apiGet } from './api';

/**
 * The company's own roles.
 *
 * Behind `roles.read`, which Owner and Admin hold and Member does not — check
 * before rendering the picker rather than letting the request 403.
 */

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  memberCount: number;
}

export interface RoleList {
  items: Role[];
  total: number;
}

export function listRoles(token: string): Promise<RoleList> {
  return apiGet<RoleList>('/roles', token);
}
