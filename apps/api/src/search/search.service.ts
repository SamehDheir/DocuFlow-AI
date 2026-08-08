import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { DocumentStatus, ProcessingStage } from '@prisma/client';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import type { SearchDto } from './dto/search.dto';
import { buildSearchQuery } from './search.sql';

/** A row as the raw query returns it, before snippet markers are structured. */
interface SearchRow {
  id: string;
  name: string;
  original_name: string;
  mime_type: string;
  extension: string;
  size: string;
  status: DocumentStatus;
  folder_id: string | null;
  owner_id: string;
  created_at: Date;
  updated_at: Date;
  language: string | null;
  summary: string | null;
  ocr_status: ProcessingStage | null;
  ai_status: ProcessingStage | null;
  rank: number;
  snippet: string | null;
}

export interface SearchHit {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  extension: string;
  size: string;
  status: DocumentStatus;
  folderId: string | null;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  language: string | null;
  summary: string | null;
  ocrStatus: ProcessingStage | null;
  aiStatus: ProcessingStage | null;
  rank: number;
  /** The matching fragment, split into plain and highlighted runs. */
  snippet: SnippetPart[] | null;
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

/** Bounded so one request cannot ask the database to rank the whole archive. */
const MAX_LIMIT = 50;
const MAX_OFFSET = 200;

@Injectable()
export class SearchService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly tenant: TenantContextService,
  ) {}

  async search(dto: SearchDto): Promise<{ items: SearchHit[]; nextOffset: number | null }> {
    const query = dto.q?.trim() ?? '';

    if (!query) {
      throw new BadRequestException(
        apiError(ERROR_CODES.SEARCH_QUERY_REQUIRED, 'Enter something to search for', {
          q: 'A search term is required',
        }),
      );
    }

    /**
     * The company comes from the bound context, which the tenant middleware set
     * from the verified JWT. Never from the DTO — accepting a company id from a
     * request is the direct path to cross-tenant reads, and this query has no
     * guard behind it to catch the mistake.
     */
    const companyId = this.tenant.getCompanyId();

    if (!companyId) {
      // Matches the guard's fail-closed posture rather than searching globally.
      throw new Error('Search attempted with no tenant context bound');
    }

    const limit = Math.min(dto.limit ?? 20, MAX_LIMIT);
    const offset = Math.min(dto.offset ?? 0, MAX_OFFSET);

    const rows = await this.db.$queryRaw<SearchRow[]>(
      buildSearchQuery({
        companyId,
        query,
        folderId: dto.folderId,
        mimeType: dto.mimeType,
        tagId: dto.tagId,
        // One extra row answers "is there more?" without a second count query.
        limit: limit + 1,
        offset,
      }),
    );

    const hits = rows.slice(0, limit);

    return {
      items: hits.map(toHit),
      /**
       * Offset paging rather than the keyset cursor used elsewhere. Rank is
       * computed per query, so there is no stable column to seek on, and deep
       * paging through relevance-ordered results is not a thing people do —
       * hence the hard MAX_OFFSET rather than an unbounded scroll.
       */
      nextOffset: rows.length > limit && offset + limit <= MAX_OFFSET ? offset + limit : null,
    };
  }
}

function toHit(row: SearchRow): SearchHit {
  return {
    id: row.id,
    name: row.name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    extension: row.extension,
    // Already cast to text in SQL: size is a BigInt and would not survive
    // JSON.stringify, exactly as in DocumentsService.
    size: row.size,
    status: row.status,
    folderId: row.folder_id,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    language: row.language,
    summary: row.summary,
    ocrStatus: row.ocr_status,
    aiStatus: row.ai_status,
    rank: Number(row.rank),
    snippet: parseSnippet(row.snippet),
  };
}

/**
 * Turns ts_headline's markers into structured parts.
 *
 * ts_headline is asked for `<<` and `>>` rather than HTML tags, and the result
 * is split here into `{ text, match }` runs. The client then renders those as
 * elements. Sending markup would mean the browser had to trust a string built
 * from document contents — user-supplied bytes — and any escaping bug there is
 * stored XSS. Structured data cannot be mistaken for markup.
 */
function parseSnippet(raw: string | null): SnippetPart[] | null {
  if (!raw) {
    return null;
  }

  const parts: SnippetPart[] = [];
  const pattern = /<<(.*?)>>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > cursor) {
      parts.push({ text: raw.slice(cursor, match.index), match: false });
    }

    parts.push({ text: match[1], match: true });
    cursor = match.index + match[0].length;
  }

  if (cursor < raw.length) {
    parts.push({ text: raw.slice(cursor), match: false });
  }

  return parts.length ? parts : null;
}
