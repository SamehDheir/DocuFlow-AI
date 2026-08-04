/**
 * The global capability catalogue.
 *
 * `permissions` is the one table with no `company_id` (see schema.prisma): it is
 * a fixed list of what the software can do, not per-tenant data. Companies
 * compose these into their own roles.
 *
 * Defined in code rather than in a seed script so that the catalogue and the
 * code that checks against it cannot drift — PermissionsService reconciles the
 * table with this list at boot, which also means a fresh database needs no
 * separate seeding step before registration works.
 */

export const PERMISSIONS = [
  { name: 'documents.create', module: 'documents', description: 'Upload documents' },
  { name: 'documents.read', module: 'documents', description: 'View and download documents' },
  { name: 'documents.update', module: 'documents', description: 'Rename, move, and re-tag' },
  { name: 'documents.delete', module: 'documents', description: 'Move documents to trash' },
  { name: 'documents.restore', module: 'documents', description: 'Restore deleted documents' },

  { name: 'folders.create', module: 'folders', description: 'Create folders' },
  { name: 'folders.read', module: 'folders', description: 'Browse the folder tree' },
  { name: 'folders.update', module: 'folders', description: 'Rename and move folders' },
  { name: 'folders.delete', module: 'folders', description: 'Delete folders' },

  { name: 'users.read', module: 'users', description: 'View colleagues' },
  { name: 'users.invite', module: 'users', description: 'Invite people to the company' },
  { name: 'users.update', module: 'users', description: 'Edit and deactivate accounts' },

  { name: 'roles.read', module: 'roles', description: 'View roles and their permissions' },
  { name: 'roles.manage', module: 'roles', description: 'Create roles and assign permissions' },

  { name: 'audit.read', module: 'audit', description: 'Read the audit trail' },
] as const;

export type PermissionName = (typeof PERMISSIONS)[number]['name'];

const ALL: readonly PermissionName[] = PERMISSIONS.map((permission) => permission.name);

/**
 * Roles materialised for every new company at registration.
 *
 * Roles are per-company rows, so each tenant gets its own copy and may edit
 * them freely afterwards — these are starting points, not system roles.
 *
 * Admin deliberately stops short of `roles.manage`: a role that can rewrite the
 * permission model can grant itself anything, which makes the distinction from
 * Owner meaningless.
 */
export const DEFAULT_ROLES = [
  {
    name: 'Owner',
    description: 'Full control, including billing and the permission model.',
    permissions: ALL,
  },
  {
    name: 'Admin',
    description: 'Manages documents and people, but not the permission model.',
    permissions: ALL.filter((name) => name !== 'roles.manage'),
  },
  {
    name: 'Member',
    description: 'Works with documents and folders.',
    permissions: [
      'documents.create',
      'documents.read',
      'documents.update',
      'documents.delete',
      'folders.create',
      'folders.read',
      'users.read',
    ] as PermissionName[],
  },
] as const;

/** The role the registering user is granted — the company has no one else yet. */
export const OWNER_ROLE = DEFAULT_ROLES[0].name;
