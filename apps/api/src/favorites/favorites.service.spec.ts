import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { FavoritesService } from './favorites.service';

interface FavoriteRow {
  documentId: string;
  userId: string;
}

/**
 * In-memory client.
 *
 * `create` raises a real P2002 on a repeat, because the composite primary key is
 * what makes the endpoint idempotent — a fake that quietly allowed the duplicate
 * would let this pass against code with no catch at all.
 */
function createDb() {
  const documents: { id: string; deletedAt: Date | null }[] = [];
  const favorites: FavoriteRow[] = [];

  const db = {
    document: {
      findFirst: ({ where }: { where: { id: string; deletedAt: null } }) =>
        Promise.resolve(
          documents.find((row) => row.id === where.id && row.deletedAt === null) ?? null,
        ),
    },
    documentFavorite: {
      create: ({ data }: { data: FavoriteRow }) => {
        if (
          favorites.some((row) => row.documentId === data.documentId && row.userId === data.userId)
        ) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          );
        }

        favorites.push({ ...data });
        return Promise.resolve({ userId: data.userId });
      },
      deleteMany: ({ where }: { where: FavoriteRow }) => {
        const before = favorites.length;

        for (let i = favorites.length - 1; i >= 0; i -= 1) {
          if (
            favorites[i].documentId === where.documentId &&
            favorites[i].userId === where.userId
          ) {
            favorites.splice(i, 1);
          }
        }

        return Promise.resolve({ count: before - favorites.length });
      },
    },
  };

  return { db, documents, favorites };
}

function setup() {
  const { db, documents, favorites } = createDb();
  const service = new FavoritesService(db as unknown as TenantGuardedClient);

  const addDocument = () => {
    const row = { id: randomUUID(), deletedAt: null as Date | null };
    documents.push(row);
    return row;
  };

  return { service, favorites, addDocument };
}

describe('FavoritesService', () => {
  it('stars a document', async () => {
    const { service, favorites, addDocument } = setup();
    const document = addDocument();
    const user = randomUUID();

    await expect(service.add(document.id, user)).resolves.toEqual({
      documentId: document.id,
      isFavorite: true,
    });

    expect(favorites).toEqual([{ documentId: document.id, userId: user }]);
  });

  /**
   * A star is a toggle. A second click on an already-lit one is not an error
   * worth showing anybody, so P2002 is read as "already starred" rather than
   * surfaced as a 409.
   */
  it('is idempotent, and does not duplicate the row', async () => {
    const { service, favorites, addDocument } = setup();
    const document = addDocument();
    const user = randomUUID();

    await service.add(document.id, user);
    await expect(service.add(document.id, user)).resolves.toEqual({
      documentId: document.id,
      isFavorite: true,
    });

    expect(favorites).toHaveLength(1);
  });

  it('unstars, and unstarring something that was never starred is fine', async () => {
    const { service, favorites, addDocument } = setup();
    const document = addDocument();
    const user = randomUUID();

    await expect(service.remove(document.id, user)).resolves.toEqual({
      documentId: document.id,
      isFavorite: false,
    });

    await service.add(document.id, user);
    await service.remove(document.id, user);

    expect(favorites).toEqual([]);
  });

  /**
   * Two colleagues keep different shortlists of the same document. This is the
   * one document-adjacent row that is not shared, and the reason `userId` is
   * inside every predicate rather than checked around one.
   */
  it("keeps one person's list out of another's", async () => {
    const { service, favorites, addDocument } = setup();
    const document = addDocument();
    const alice = randomUUID();
    const bob = randomUUID();

    await service.add(document.id, alice);
    await service.add(document.id, bob);
    await service.remove(document.id, alice);

    expect(favorites).toEqual([{ documentId: document.id, userId: bob }]);
  });

  it('404s a document in the trash rather than starring it', async () => {
    const { service, addDocument } = setup();
    const document = addDocument();
    document.deletedAt = new Date();

    await expect(service.add(document.id, randomUUID())).rejects.toThrow(/does not exist/);
    await expect(service.remove(document.id, randomUUID())).rejects.toThrow(/does not exist/);
  });

  it('404s an id that never existed', async () => {
    const { service } = setup();

    await expect(service.add(randomUUID(), randomUUID())).rejects.toThrow(/does not exist/);
  });
});
