import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_MODEL_REGISTRY } from './tenant-guard';

/**
 * Reconciles the guard's model lists against the schema itself.
 *
 * `TENANT_SCOPED_MODELS` carries a "keep in sync with schema.prisma" comment,
 * and that instruction was missed the first time a model was added after it was
 * written — `Invitation` shipped with a `company_id` column and no entry, so the
 * guard skipped it and `invitation.findMany()` would have returned every
 * company's rows. Nothing caught it: it type-checks, it lints, and unit tests
 * that construct services with fakes never touch the extension.
 *
 * A comment cannot enforce itself. This reads the schema and fails if a model
 * with a `companyId` field is in neither list, so the next one cannot be
 * forgotten quietly — the failure names the model and says which list it
 * belongs in.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Every `model X { ... }` block, as a name → body map. */
function parseModels(schema: string): Map<string, string> {
  const models = new Map<string, string>();
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of schema.matchAll(pattern)) {
    models.set(match[1], match[2]);
  }

  return models;
}

const MODELS = parseModels(SCHEMA);

describe('tenant guard model registry', () => {
  it('parses the schema it is asserting against', () => {
    // A regex that silently matched nothing would make every test below pass.
    expect(MODELS.size).toBeGreaterThan(10);
    expect(MODELS.has('Document')).toBe(true);
  });

  it('scopes every model that carries a companyId column', () => {
    const owning = [...MODELS.entries()]
      .filter(([, body]) => /^\s*companyId\s+String/m.test(body))
      .map(([name]) => name);

    // Sanity: the models this rule exists for are actually found.
    expect(owning).toContain('Document');
    expect(owning).toContain('Invitation');

    const unregistered = owning.filter((name) => !TENANT_MODEL_REGISTRY.scoped.has(name));

    expect(unregistered).toEqual([]);
  });

  it('accounts for every model with no companyId of its own', () => {
    const orphans = [...MODELS.entries()]
      .filter(([, body]) => !/^\s*companyId\s+String/m.test(body))
      .map(([name]) => name)
      .filter(
        (name) =>
          name !== TENANT_MODEL_REGISTRY.root &&
          // The one global table: a fixed catalogue of capabilities, not
          // per-tenant data.
          name !== 'Permission',
      );

    const unaccounted = orphans.filter((name) => !TENANT_MODEL_REGISTRY.transitive.has(name));

    expect(unaccounted).toEqual([]);
  });

  it('does not claim to scope a model the schema no longer has', () => {
    const stale = [...TENANT_MODEL_REGISTRY.scoped, ...TENANT_MODEL_REGISTRY.transitive].filter(
      (name) => !MODELS.has(name),
    );

    expect(stale).toEqual([]);
  });
});
