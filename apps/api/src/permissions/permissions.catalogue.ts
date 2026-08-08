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
  /**
   * Deciding an approval, not requesting one. Asking for sign-off is part of
   * ordinary document work and rides on `documents.update`; granting it is the
   * privileged half, so it is separate and withheld from Member.
   */
  { name: 'documents.approve', module: 'documents', description: 'Approve or reject documents' },

  { name: 'search.read', module: 'search', description: 'Search document contents' },

  /**
   * Applying a tag to a document is not here — it rides on `documents.update`,
   * whose description has promised "re-tag" since v1. Managing the vocabulary
   * is the separate power: tag names are a company-wide shared namespace, and
   * renaming one silently relabels every document carrying it.
   */
  { name: 'tags.read', module: 'tags', description: 'See tags and filter by them' },
  { name: 'tags.manage', module: 'tags', description: 'Create, rename and delete tags' },

  /**
   * Reading a discussion rides on `documents.read`: if you may open the
   * document you may see what was said about it, and a separate read permission
   * would only produce documents whose comment count you can see but not the
   * comments. Moderating is the privileged half and is withheld from Member.
   */
  { name: 'comments.create', module: 'comments', description: 'Comment on documents' },
  { name: 'comments.moderate', module: 'comments', description: "Delete anyone's comment" },

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
    /**
     * Notably absent: `documents.approve`. A Member can request sign-off — that
     * rides on `documents.update` — but approving your own request would make
     * the whole workflow decorative.
     */
    permissions: [
      'documents.create',
      'documents.read',
      'documents.update',
      'documents.delete',
      'folders.create',
      'folders.read',
      'users.read',
      'search.read',
      /**
       * v4. A Member reads tags and joins the conversation, but does not own
       * the company's tag vocabulary and cannot delete a colleague's comment.
       */
      'tags.read',
      'comments.create',
    ] as PermissionName[],
  },
] as const;

/** The role the registering user is granted — the company has no one else yet. */
export const OWNER_ROLE = DEFAULT_ROLES[0].name;
