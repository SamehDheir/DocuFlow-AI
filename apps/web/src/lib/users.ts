import { apiGet, apiSend } from './api';

/**
 * Colleagues within the current company.
 *
 * Behind the `users.read` permission, which Member holds but a future
 * restricted role may not — check before rendering.
 */

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  roles: string[];
}

export interface MemberList {
  items: Member[];
  total: number;
}

export function listUsers(token: string): Promise<MemberList> {
  return apiGet<MemberList>('/users', token);
}

/**
 * Replaces a member's roles with exactly this set.
 *
 * Behind `roles.manage`, which only Owner holds — Admin manages people but
 * deliberately not the permission model, or the distinction between the two
 * would be meaningless. The API refuses to demote the last Owner.
 */
export function setUserRoles(token: string, userId: string, roleIds: string[]): Promise<Member> {
  return apiSend('PUT', `/users/${userId}/roles`, token, { roleIds });
}
