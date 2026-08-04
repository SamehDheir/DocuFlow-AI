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
});
