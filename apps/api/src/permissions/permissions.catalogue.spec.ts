import { DEFAULT_ROLES, OWNER_ROLE, PERMISSIONS } from './permissions.catalogue';

describe('permission catalogue', () => {
  const names = new Set(PERMISSIONS.map((permission) => permission.name));

  it('has no duplicate names', () => {
    // `name` is unique in the database, so a duplicate here fails the boot sync
    // rather than the code that introduced it.
    expect(names.size).toBe(PERMISSIONS.length);
  });

  it('grants only permissions that exist', () => {
    // Registration resolves these to row ids and drops anything it cannot find.
    // A typo would therefore create a role quietly missing that capability.
    for (const role of DEFAULT_ROLES) {
      for (const permission of role.permissions) {
        expect(names).toContain(permission);
      }
    }
  });

  it('gives Owner the full catalogue', () => {
    const owner = DEFAULT_ROLES.find((role) => role.name === OWNER_ROLE);

    expect(owner?.permissions).toHaveLength(PERMISSIONS.length);
  });

  it('withholds roles.manage from Admin', () => {
    // A role that can rewrite the permission model can grant itself anything,
    // which would leave no real distinction from Owner.
    const admin = DEFAULT_ROLES.find((role) => role.name === 'Admin');

    expect(admin?.permissions).not.toContain('roles.manage');
  });

  it('keeps Member strictly below Admin', () => {
    const admin = new Set<string>(DEFAULT_ROLES.find((role) => role.name === 'Admin')?.permissions);
    const member = DEFAULT_ROLES.find((role) => role.name === 'Member');

    expect(member?.permissions.every((permission) => admin.has(permission))).toBe(true);
    expect(member?.permissions.length).toBeLessThan(admin.size);
  });

  /**
   * The v4 split, asserted explicitly rather than left to the subset rule above.
   *
   * Both distinctions are easy to erase by "tidying" the Member array, and both
   * are the point: a tag name is a company-wide shared namespace where a rename
   * relabels every document carrying it, and deleting a colleague's comment is
   * moderation rather than participation.
   */
  it('lets Member join in without owning the vocabulary or the thread', () => {
    const member = new Set<string>(
      DEFAULT_ROLES.find((role) => role.name === 'Member')?.permissions,
    );

    expect(member.has('tags.read')).toBe(true);
    expect(member.has('comments.create')).toBe(true);

    expect(member.has('tags.manage')).toBe(false);
    expect(member.has('comments.moderate')).toBe(false);
  });

  /**
   * There is no `comments.read`. Reading a discussion rides on `documents.read`,
   * so anyone who can open a document can see what was said about it; a separate
   * read permission would only produce documents whose comment count is visible
   * but whose comments are not.
   */
  it('does not introduce a separate comment read permission', () => {
    expect(names).not.toContain('comments.read');
  });
});
