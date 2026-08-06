import { apiFetch, apiGet, apiSend } from './api';

/**
 * Invitations — the one path by which a company gains a second person.
 *
 * `register` always creates a new company, so everything here is behind
 * `users.invite`, except the two calls the invitee makes before they have an
 * account at all.
 */

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface Invitation {
  id: string;
  email: string;
  role: { id: string; name: string };
  status: InvitationStatus;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationList {
  items: Invitation[];
  total: number;
}

/** What the accept screen may show before anyone has signed in. */
export interface InvitationPreview {
  email: string;
  companyName: string;
  roleName: string;
}

export function listInvitations(token: string): Promise<InvitationList> {
  return apiGet<InvitationList>('/invitations', token);
}

/**
 * Returns the link as well as the row.
 *
 * There is no mailer in this stack, so the inviter delivers it themselves —
 * the UI copies it to the clipboard. Withholding the token from the
 * administrator who just created it would make the feature unusable.
 */
export function createInvitation(
  token: string,
  body: { email: string; roleId: string },
): Promise<{ invitation: Invitation; link: string }> {
  return apiSend('POST', '/invitations', token, body);
}

export function revokeInvitation(token: string, id: string): Promise<Invitation> {
  return apiSend('DELETE', `/invitations/${id}`, token);
}

/**
 * Unauthenticated: the person holding the link has no account yet.
 *
 * POST with the token in the body rather than GET with it in the path — an
 * invitation token is a bearer credential and a path lands in every access log
 * between here and the API.
 */
export function previewInvitation(inviteToken: string): Promise<InvitationPreview> {
  return apiFetch<InvitationPreview>('/invitations/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken }),
  });
}
