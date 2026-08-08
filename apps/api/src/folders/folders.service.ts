import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import type { CreateFolderDto } from './dto/create-folder.dto';
import type { UpdateFolderDto } from './dto/update-folder.dto';

/**
 * How deep the tree may go.
 *
 * Not a storage limit — object keys are flat and carry no folder path. It is a
 * usability one: a breadcrumb and a sidebar stop being readable long before
 * this, and an unbounded tree makes ancestor walks unbounded too.
 */
export const MAX_FOLDER_DEPTH = 10;

const FOLDER_SUMMARY = {
  id: true,
  name: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const;

export type FolderSummary = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
};

/**
 * A folder as the sidebar lists it.
 *
 * `documentCount` counts the files filed DIRECTLY in the folder, not its
 * subtree — so the number beside a folder is exactly what selecting it shows,
 * and matches the `documentCount` GET /folders/:id already returns. A rolled-up
 * subtree total would disagree with the list on screen.
 */
export type FolderListItem = FolderSummary & { documentCount: number };

@Injectable()
export class FoldersService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: CreateFolderDto,
    userId: string,
    context: RequestContext,
  ): Promise<FolderSummary> {
    if (dto.parentId) {
      const parent = await this.mustFind(dto.parentId);
      const depth = await this.depthOf(parent.id);

      if (depth + 1 >= MAX_FOLDER_DEPTH) {
        throw new BadRequestException(
          apiError(
            ERROR_CODES.FOLDER_DEPTH_EXCEEDED,
            `Folders cannot be nested more than ${MAX_FOLDER_DEPTH} levels deep`,
          ),
        );
      }
    }

    await this.assertNameAvailable(dto.name, dto.parentId ?? null);

    const folder = await this.db.folder.create({
      data: tenantCreate({ name: dto.name, parentId: dto.parentId ?? null, createdById: userId }),
      select: FOLDER_SUMMARY,
    });

    await this.audit.record({
      action: 'folder.create',
      entityType: 'Folder',
      entityId: folder.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: folder.name, parentId: folder.parentId },
    });

    return folder;
  }

  /**
   * Folders for the current company.
   *
   * Returns the whole set flat and lets the client assemble the tree — folders
   * are orders of magnitude fewer than documents, and one request beats a
   * round trip per expanded node. Pass `parentId` to fetch a single level
   * instead, which is what a lazily-expanding sidebar wants.
   */
  async list(parentId?: string | null): Promise<FolderListItem[]> {
    const [folders, counts] = await Promise.all([
      this.db.folder.findMany({
        where: parentId === undefined ? {} : { parentId },
        select: FOLDER_SUMMARY,
        orderBy: { name: 'asc' },
      }),
      /**
       * Every folder's document count in ONE aggregate rather than a count per
       * folder — the sidebar renders the whole tree, so a per-node query would
       * be an N+1 that grows with the customer's filing depth.
       *
       * `deletedAt: null` is spelled out because the tenant guard handles
       * companyId only; a trashed file must not still be counted against the
       * folder it came from.
       *
       * ARCHIVED is excluded for the same reason, and the two must stay in step
       * with the document list's default filter: a badge reading "12" over a
       * folder that opens to show 9 documents reads as a counting bug, and the
       * reader has no way to discover that three of them are archived.
       */
      this.db.document.groupBy({
        by: ['folderId'],
        where: { deletedAt: null, status: { not: DocumentStatus.ARCHIVED } },
        _count: { _all: true },
      }),
    ]);

    const countFor = new Map(counts.map((row) => [row.folderId, row._count._all]));

    return folders.map((folder) => ({
      ...folder,
      documentCount: countFor.get(folder.id) ?? 0,
    }));
  }

  /** A folder with its immediate children and the path back to the root. */
  async findOne(id: string): Promise<{
    folder: FolderSummary;
    children: FolderSummary[];
    breadcrumb: { id: string; name: string }[];
    documentCount: number;
  }> {
    const folder = await this.mustFind(id);

    const [children, breadcrumb, documentCount] = await Promise.all([
      this.db.folder.findMany({
        where: { parentId: id },
        select: FOLDER_SUMMARY,
        orderBy: { name: 'asc' },
      }),
      this.breadcrumbFor(folder),
      // Same predicate as the tree count above, and as the document list's
      // default filter. All three have to agree or the numbers contradict.
      this.db.document.count({
        where: { folderId: id, deletedAt: null, status: { not: DocumentStatus.ARCHIVED } },
      }),
    ]);

    return { folder, children, breadcrumb, documentCount };
  }

  async update(id: string, dto: UpdateFolderDto, context: RequestContext): Promise<FolderSummary> {
    const folder = await this.mustFind(id);

    const moving = dto.parentId !== undefined;
    const nextParentId = moving ? (dto.parentId ?? null) : folder.parentId;
    const nextName = dto.name ?? folder.name;

    if (moving && nextParentId !== folder.parentId) {
      await this.assertMoveIsLegal(folder, nextParentId);
    }

    if (nextName !== folder.name || nextParentId !== folder.parentId) {
      await this.assertNameAvailable(nextName, nextParentId, id);
    }

    const updated = await this.db.folder.update({
      where: { id },
      data: { name: nextName, parentId: nextParentId },
      select: FOLDER_SUMMARY,
    });

    // Renaming and moving are different things to a reader of the audit trail,
    // so they are recorded as different actions even though one endpoint does
    // both.
    if (nextName !== folder.name) {
      await this.audit.record({
        action: 'folder.rename',
        entityType: 'Folder',
        entityId: id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { from: folder.name, to: nextName },
      });
    }

    if (nextParentId !== folder.parentId) {
      await this.audit.record({
        action: 'folder.move',
        entityType: 'Folder',
        entityId: id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { from: folder.parentId, to: nextParentId },
      });
    }

    return updated;
  }

  /**
   * Deletes an empty folder.
   *
   * The schema cascades `Folder → children` and nulls `Document.folderId`, so
   * an unguarded delete would silently destroy a subtree and unfile everything
   * under it. That is the exact failure the product exists to prevent, so a
   * non-empty folder is refused and the caller has to empty it deliberately.
   */
  async remove(id: string, context: RequestContext): Promise<void> {
    const folder = await this.mustFind(id);

    const [childCount, documentCount] = await Promise.all([
      this.db.folder.count({ where: { parentId: id } }),
      // Counts trashed documents too: they are restorable, and restoring one
      // into a folder that no longer exists would strand it at the root.
      this.db.document.count({ where: { folderId: id } }),
    ]);

    if (childCount > 0 || documentCount > 0) {
      throw new ConflictException(
        apiError(
          ERROR_CODES.FOLDER_NOT_EMPTY,
          'This folder still has items in it. Move or delete them first.',
          {
            folders: String(childCount),
            documents: String(documentCount),
          },
        ),
      );
    }

    await this.db.folder.delete({ where: { id } });

    await this.audit.record({
      action: 'folder.delete',
      entityType: 'Folder',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: folder.name, parentId: folder.parentId },
    });
  }

  /**
   * Loads a folder or 404s.
   *
   * `findFirst`, not `findUnique`: the tenant guard scopes a findFirst before
   * it executes, whereas findUnique is only verified afterwards. Both are safe,
   * but pre-filtering means another company's id simply matches nothing.
   */
  private async mustFind(id: string): Promise<FolderSummary> {
    const folder = await this.db.folder.findFirst({ where: { id }, select: FOLDER_SUMMARY });

    if (!folder) {
      throw new NotFoundException(
        apiError(ERROR_CODES.FOLDER_NOT_FOUND, 'That folder does not exist'),
      );
    }

    return folder;
  }

  /**
   * Rejects a duplicate name among siblings.
   *
   * `@@unique([companyId, parentId, name])` covers this for nested folders, but
   * PostgreSQL treats NULLs as distinct — so it does NOT stop two folders with
   * the same name at the root, which the schema comment calls out explicitly.
   * Checking here covers both cases and produces a usable message instead of a
   * raw constraint violation.
   *
   * KNOWN LIMIT: read-then-write, so two simultaneous requests can still race.
   * For nested folders the database constraint catches the loser and the Prisma
   * filter turns it into a 409; at the root there is no constraint to catch it,
   * and the duplicate is allowed to exist. Fixing that properly needs a partial
   * unique index on `(company_id, name) WHERE parent_id IS NULL`, which is a
   * migration rather than application code.
   */
  private async assertNameAvailable(
    name: string,
    parentId: string | null,
    excludeId?: string,
  ): Promise<void> {
    const clash = await this.db.folder.findFirst({
      where: { name, parentId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictException(
        apiError(ERROR_CODES.FOLDER_NAME_TAKEN, 'A folder with this name is already here', {
          name: 'A folder with this name is already here',
        }),
      );
    }
  }

  /** Refuses a move that would detach a subtree from the root or overflow the depth cap. */
  private async assertMoveIsLegal(
    folder: FolderSummary,
    nextParentId: string | null,
  ): Promise<void> {
    if (nextParentId === null) {
      return;
    }

    if (nextParentId === folder.id) {
      throw new BadRequestException(
        apiError(ERROR_CODES.FOLDER_CYCLE, 'A folder cannot be moved inside itself'),
      );
    }

    const parent = await this.mustFind(nextParentId);

    // Walk up from the intended parent. Meeting the folder being moved means
    // the target is one of its own descendants, and committing the move would
    // orphan the whole branch from the root — unreachable, and undeletable
    // because nothing would ever be empty.
    let cursor: string | null = parent.parentId;
    let depth = 1;

    while (cursor) {
      if (cursor === folder.id) {
        throw new BadRequestException(
          apiError(
            ERROR_CODES.FOLDER_CYCLE,
            'A folder cannot be moved inside one of its own subfolders',
          ),
        );
      }

      const ancestor: FolderSummary = await this.mustFind(cursor);
      cursor = ancestor.parentId;
      depth += 1;
    }

    /**
     * Checks the destination's depth, not the height of the moved subtree, so a
     * deep branch moved under a deep parent can still end up past the cap. It
     * is a display limit rather than an invariant, and measuring subtree height
     * costs a recursive query on every move.
     */
    if (depth + 1 > MAX_FOLDER_DEPTH) {
      throw new BadRequestException(
        apiError(
          ERROR_CODES.FOLDER_DEPTH_EXCEEDED,
          `Folders cannot be nested more than ${MAX_FOLDER_DEPTH} levels deep`,
        ),
      );
    }
  }

  /** How many ancestors a folder has. Bounded by MAX_FOLDER_DEPTH. */
  private async depthOf(id: string): Promise<number> {
    let cursor: string | null = id;
    let depth = 0;

    while (cursor && depth <= MAX_FOLDER_DEPTH) {
      const folder: FolderSummary = await this.mustFind(cursor);
      cursor = folder.parentId;
      depth += 1;
    }

    return depth;
  }

  /** Root-first path to the folder, for a breadcrumb. */
  private async breadcrumbFor(folder: FolderSummary): Promise<{ id: string; name: string }[]> {
    const trail = [{ id: folder.id, name: folder.name }];
    let cursor = folder.parentId;

    while (cursor && trail.length <= MAX_FOLDER_DEPTH) {
      const ancestor: FolderSummary = await this.mustFind(cursor);
      trail.unshift({ id: ancestor.id, name: ancestor.name });
      cursor = ancestor.parentId;
    }

    return trail;
  }
}
