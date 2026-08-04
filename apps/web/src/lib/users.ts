import { apiGet } from './api';

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
