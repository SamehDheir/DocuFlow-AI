import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import { ACTIVE } from '../documents/document-rules';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';

export interface FavoriteState {
  documentId: string;
  isFavorite: boolean;
}

/**
 * Private bookmarks — spec §12, Organization.
 *
 * The one document-adjacent row that is not shared: two colleagues keep
 * different shortlists of the same documents. Three consequences run through
 * this file:
 *
 *  1. **`userId` always comes from the authenticated principal.** The tenant
 *     guard scopes rows to the company, but every colleague shares that company
 *     — favouriting on someone else's behalf, or reading their list, is a
 *     within-tenant leak the guard cannot see.
 *
 *  2. **Nothing is audited.** A favourite changes nothing about the document,
 *     and an audit row would publish a private shortlist to everyone holding
 *     `audit.read`. The activity feed exists to answer "who changed this file",
 *     and starring it is not a change to it.
 *
 *  3. **No permission beyond `documents.read`.** Being able to open a document
 *     is the whole prerequisite for keeping a pointer to it.
 */
@Injectable()
export class FavoritesService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}

  /**
   * Stars a document. Idempotent.
   *
   * A create, never an upsert: the guard refuses an upsert whose where-clause
   * cannot pin the tenant, and `@@id([userId, documentId])` does not include
   * `companyId`. So the composite primary key is left to reject the duplicate,
   * and P2002 is read as "already starred" rather than as a conflict — a star is
   * a toggle, and a second click on an already-lit one is not an error worth
   * showing anybody.
   */
  async add(documentId: string, userId: string): Promise<FavoriteState> {
    await this.mustFindDocument(documentId);

    try {
      await this.db.documentFavorite.create({
        data: tenantCreate({ documentId, userId }),
        select: { userId: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    return { documentId, isFavorite: true };
  }

  /**
   * Unstars. Idempotent, and `deleteMany` is what makes it so.
   *
   * `delete` would throw P2025 on a row that is not there, turning the second
   * half of a toggle into a 404. This also keeps `userId` inside the predicate
   * rather than trusting a check around it.
   */
  async remove(documentId: string, userId: string): Promise<FavoriteState> {
    await this.mustFindDocument(documentId);

    await this.db.documentFavorite.deleteMany({ where: { documentId, userId } });

    return { documentId, isFavorite: false };
  }

  /**
   * Confirms the document is in this tenant and not in the trash.
   *
   * Checked even though the foreign key would catch a bad id, because the FK
   * failure is a 500 with a constraint name in it — and because a trashed
   * document reads as gone everywhere else, so starring one would be the single
   * endpoint that disagreed.
   */
  private async mustFindDocument(documentId: string): Promise<void> {
    const document = await this.db.document.findFirst({
      where: { id: documentId, ...ACTIVE },
      select: { id: true },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }
  }
}
