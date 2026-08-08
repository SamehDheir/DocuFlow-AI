import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentStatus, type Prisma } from '@prisma/client';
import { AuditService, type AuditEntry } from '../common/audit/audit.service';
import { ERROR_CODES, apiError, type ErrorCode } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { isArchived, isInFlight } from './document-rules';
import type {
  BulkDocumentsDto,
  BulkMoveDocumentsDto,
  BulkTagDocumentsDto,
} from './dto/bulk-documents.dto';

/** What each id was refused for. Codes, so the web can translate them. */
export interface BulkSkip {
  id: string;
  code: ErrorCode;
}

export interface BulkResult {
  requested: number;
  succeeded: string[];
  skipped: BulkSkip[];
}

/** Just enough of a document to decide whether an action may touch it. */
const CANDIDATE = {
  id: true,
  name: true,
  status: true,
  folderId: true,
  deletedAt: true,
} satisfies Prisma.DocumentSelect;

type Candidate = Prisma.DocumentGetPayload<{ select: typeof CANDIDATE }>;

/**
 * Acting on a selection.
 *
 * PARTIAL SUCCESS IS THE CONTRACT, not a fallback. A multi-select runs over a
 * paginated list, so some rows are always stale by the time the button is
 * pressed — a colleague archived one, a worker picked another up. All-or-nothing
 * would mean a user can never complete the action without hunting for whichever
 * id went bad, and there is no invariant across the selection for a transaction
 * to protect: fifty deletes are fifty independent facts. So every id is reported
 * as either done or skipped-with-a-reason, and the response is a 200 either way.
 *
 * The eligibility rules are NOT re-derived here. They come from
 * `document-rules.ts`, which DocumentsService reads from too — bulk archive
 * refusing an in-flight document and `archive()` refusing one have to stay the
 * same rule, and the only way to guarantee that is for there to be one.
 *
 * Permission is checked once, at the route, because permissions in this system
 * are company-wide rather than per-document. If per-document ACLs ever arrive,
 * this is the file that grows a filter step.
 */
@Injectable()
export class BulkDocumentsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly audit: AuditService,
  ) {}

  /** Moves a selection to the trash. Archived documents included — see below. */
  async remove(dto: BulkDocumentsDto, context: RequestContext): Promise<BulkResult> {
    const { candidates, result } = await this.load(dto.ids);

    /**
     * Archived is not a reason to refuse here, matching `assertWritable`, which
     * is deliberately not applied to deletion: freezing a record is not sealing
     * it away, and an archived document nobody could ever throw out would be a
     * worse outcome than one thrown out by mistake — the trash is reversible.
     */
    const eligible = this.partition(candidates, result, (document) =>
      document.deletedAt ? ERROR_CODES.DOCUMENT_NOT_FOUND : null,
    );

    await this.apply(eligible, result, {
      data: { deletedAt: new Date(), status: DocumentStatus.DELETED },
      action: 'document.delete',
      context,
      metadataFor: (document) => ({ name: document.name, folderId: document.folderId }),
    });

    return result;
  }

  async restore(dto: BulkDocumentsDto, context: RequestContext): Promise<BulkResult> {
    const { candidates, result } = await this.load(dto.ids);

    const eligible = this.partition(candidates, result, (document) =>
      document.deletedAt ? null : ERROR_CODES.DOCUMENT_NOT_DELETED,
    );

    /**
     * Lands at READY, exactly as the single-document restore does — including
     * for a document that was archived when it was deleted. Archive is a status
     * and `remove()` overwrote it; recovering it would need a column recording
     * the status before deletion, which is not worth carrying.
     */
    await this.apply(eligible, result, {
      data: { deletedAt: null, status: DocumentStatus.READY },
      action: 'document.restore',
      context,
      metadataFor: (document) => ({ name: document.name }),
    });

    return result;
  }

  async archive(dto: BulkDocumentsDto, context: RequestContext): Promise<BulkResult> {
    const { candidates, result } = await this.load(dto.ids);

    const eligible = this.partition(candidates, result, (document) => {
      if (document.deletedAt) return ERROR_CODES.DOCUMENT_NOT_FOUND;
      if (isArchived(document.status)) return ERROR_CODES.DOCUMENT_ALREADY_ARCHIVED;
      // The pipeline ends with an unconditional advance to READY, so a document
      // archived mid-run would quietly un-archive itself when the worker
      // finished, with nothing in the trail to explain it.
      if (isInFlight(document.status)) return ERROR_CODES.DOCUMENT_ALREADY_PROCESSING;
      return null;
    });

    await this.apply(eligible, result, {
      data: { status: DocumentStatus.ARCHIVED },
      action: 'document.archive',
      context,
      metadataFor: (document) => ({ name: document.name }),
    });

    return result;
  }

  async unarchive(dto: BulkDocumentsDto, context: RequestContext): Promise<BulkResult> {
    const { candidates, result } = await this.load(dto.ids);

    const eligible = this.partition(candidates, result, (document) => {
      if (document.deletedAt) return ERROR_CODES.DOCUMENT_NOT_FOUND;
      if (!isArchived(document.status)) return ERROR_CODES.DOCUMENT_NOT_ARCHIVED;
      return null;
    });

    await this.apply(eligible, result, {
      data: { status: DocumentStatus.READY },
      action: 'document.unarchive',
      context,
      metadataFor: (document) => ({ name: document.name }),
    });

    return result;
  }

  /** Re-files a selection. `folderId: null` is the company root. */
  async move(dto: BulkMoveDocumentsDto, context: RequestContext): Promise<BulkResult> {
    if (dto.folderId) {
      await this.assertFolderExists(dto.folderId);
    }

    const { candidates, result } = await this.load(dto.ids);

    const eligible = this.partition(candidates, result, (document) => {
      if (document.deletedAt) return ERROR_CODES.DOCUMENT_NOT_FOUND;
      // Archive IS read-only for a move, matching `assertWritable`: re-filing
      // changes what the document is, where deleting it does not.
      if (isArchived(document.status)) return ERROR_CODES.DOCUMENT_ARCHIVED;
      return null;
    });

    await this.apply(eligible, result, {
      data: { folderId: dto.folderId },
      action: 'document.move',
      context,
      metadataFor: (document) => ({
        name: document.name,
        from: document.folderId,
        to: dto.folderId,
      }),
    });

    return result;
  }

  /**
   * Adds and/or removes tags across a selection.
   *
   * The writes go against `DocumentTag` DIRECTLY, which the tenant guard does
   * not filter — that model carries no companyId and is only transitively
   * scoped. This is the sanctioned form of that escape hatch: every id in
   * `eligible` came back from a tenant-scoped `document.findMany`, and every tag
   * id from a tenant-scoped `tag.findMany`, so both sides are proven to be this
   * company's before either statement runs. The alternative — a nested write per
   * document through the scoped parent — is correct too and costs one round trip
   * per selected row.
   */
  async setTags(dto: BulkTagDocumentsDto, context: RequestContext): Promise<BulkResult> {
    const add = [...new Set(dto.add ?? [])];
    const remove = [...new Set(dto.remove ?? [])];

    if (add.length === 0 && remove.length === 0) {
      throw new BadRequestException(
        apiError(ERROR_CODES.BULK_NO_CHANGES, 'Choose at least one tag to add or remove', {
          add: 'Choose at least one tag',
        }),
      );
    }

    // An id in both halves is a request that contradicts itself; refusing is
    // better than picking an order and calling it the answer.
    const contradictory = add.filter((id) => remove.includes(id));

    if (contradictory.length > 0) {
      throw new BadRequestException(
        apiError(ERROR_CODES.BULK_NO_CHANGES, 'A tag cannot be both added and removed'),
      );
    }

    await this.assertTagsExist([...add, ...remove]);

    const { candidates, result } = await this.load(dto.ids);

    const eligible = this.partition(candidates, result, (document) => {
      if (document.deletedAt) return ERROR_CODES.DOCUMENT_NOT_FOUND;
      if (isArchived(document.status)) return ERROR_CODES.DOCUMENT_ARCHIVED;
      return null;
    });

    if (eligible.length === 0) {
      return result;
    }

    const ids = eligible.map((document) => document.id);

    if (remove.length > 0) {
      await this.db.documentTag.deleteMany({
        where: { documentId: { in: ids }, tagId: { in: remove } },
      });
    }

    if (add.length > 0) {
      await this.db.documentTag.createMany({
        // skipDuplicates leans on @@id([documentId, tagId]): re-applying a tag a
        // document already carries is a no-op, not a conflict.
        data: ids.flatMap((documentId) => add.map((tagId) => ({ documentId, tagId }))),
        skipDuplicates: true,
      });
    }

    result.succeeded.push(...ids);

    await this.audit.recordMany(
      eligible.map((document) =>
        this.entryFor('document.tags.set', document, context, {
          name: document.name,
          added: add,
          removed: remove,
        }),
      ),
    );

    return result;
  }

  /**
   * Reads every requested id in ONE query and marks the misses.
   *
   * The read is tenant-scoped, so an id belonging to another company simply does
   * not come back and is reported as not-found — indistinguishable from an id
   * that never existed, which is the answer that leaks least.
   */
  private async load(ids: string[]): Promise<{ candidates: Candidate[]; result: BulkResult }> {
    const wanted = [...new Set(ids)];

    const candidates = await this.db.document.findMany({
      where: { id: { in: wanted } },
      select: CANDIDATE,
    });

    const found = new Set(candidates.map((document) => document.id));

    return {
      candidates,
      result: {
        requested: wanted.length,
        succeeded: [],
        skipped: wanted
          .filter((id) => !found.has(id))
          .map((id) => ({ id, code: ERROR_CODES.DOCUMENT_NOT_FOUND })),
      },
    };
  }

  /** Splits candidates by a per-action rule, recording why each refusal happened. */
  private partition(
    candidates: Candidate[],
    result: BulkResult,
    refuse: (document: Candidate) => ErrorCode | null,
  ): Candidate[] {
    const eligible: Candidate[] = [];

    for (const document of candidates) {
      const code = refuse(document);

      if (code) {
        result.skipped.push({ id: document.id, code });
      } else {
        eligible.push(document);
      }
    }

    return eligible;
  }

  /** One `updateMany` for the whole eligible set, then one audit statement. */
  private async apply(
    eligible: Candidate[],
    result: BulkResult,
    options: {
      /**
       * Unchecked, so `folderId` can be set directly. The checked variant
       * excludes relation scalars in favour of a nested `connect`, which
       * `updateMany` has no way to express.
       */
      data: Prisma.DocumentUncheckedUpdateManyInput;
      action: string;
      context: RequestContext;
      metadataFor: (document: Candidate) => Record<string, unknown>;
    },
  ): Promise<void> {
    if (eligible.length === 0) {
      return;
    }

    const ids = eligible.map((document) => document.id);

    await this.db.document.updateMany({ where: { id: { in: ids } }, data: options.data });

    result.succeeded.push(...ids);

    await this.audit.recordMany(
      eligible.map((document) =>
        this.entryFor(options.action, document, options.context, options.metadataFor(document)),
      ),
    );
  }

  /**
   * The action name is the SAME one the single-document route writes, so an
   * existing `?action=document.delete` filter keeps working and the activity
   * feed reads identically. `bulk` in the metadata is what distinguishes fifty
   * deliberate deletions from one careless click.
   */
  private entryFor(
    action: string,
    document: Candidate,
    context: RequestContext,
    metadata: Record<string, unknown>,
  ): AuditEntry {
    return {
      action,
      entityType: 'Document',
      entityId: document.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { ...metadata, bulk: true },
    };
  }

  private async assertFolderExists(folderId: string): Promise<void> {
    const folder = await this.db.folder.findFirst({
      where: { id: folderId },
      select: { id: true },
    });

    if (!folder) {
      throw new NotFoundException(
        apiError(ERROR_CODES.FOLDER_NOT_FOUND, 'That folder does not exist'),
      );
    }
  }

  /**
   * Resolved before anything is written, and the read is tenant-scoped — so a
   * tag id from another company does not come back and the whole call is
   * refused. Letting `createMany` discover it would surface a raw foreign-key
   * violation as a 500.
   */
  private async assertTagsExist(ids: string[]): Promise<void> {
    const wanted = [...new Set(ids)];
    const tags = await this.db.tag.findMany({
      where: { id: { in: wanted } },
      select: { id: true },
    });

    if (tags.length !== wanted.length) {
      throw new NotFoundException(apiError(ERROR_CODES.TAG_NOT_FOUND, 'That tag does not exist'));
    }
  }
}
