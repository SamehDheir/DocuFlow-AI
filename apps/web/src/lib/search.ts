import { apiGet, query } from './api';
import type { DocumentStatus, ProcessingStage } from './documents';

/**
 * Full-text search across document contents.
 *
 * Distinct from the `q=` filter on the documents list, which only matches
 * filenames. This searches the extracted body — the text OCR and the document
 * parsers produced — which is the point of v2.
 */

/**
 * A snippet arrives pre-split rather than as a marked-up string.
 *
 * The API returns `{ text, match }` runs instead of HTML because the content is
 * user-supplied document text: rendering a server-built string as markup would
 * make every escaping bug a stored XSS. Structured parts cannot be mistaken for
 * markup by React, which escapes text nodes by construction.
 */
export interface SnippetPart {
  text: string;
  match: boolean;
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
  createdAt: string;
  updatedAt: string;
  language: string | null;
  summary: string | null;
  ocrStatus: ProcessingStage | null;
  aiStatus: ProcessingStage | null;
  /** Relevance. Only meaningful relative to other hits in the same response. */
  rank: number;
  snippet: SnippetPart[] | null;
}

export interface SearchResults {
  items: SearchHit[];
  /**
   * Offset rather than a cursor, unlike every other list in this app: rank is
   * computed per query, so there is no stable column to seek from. Null once
   * the server's bounded window is exhausted.
   */
  nextOffset: number | null;
}

export interface SearchOptions {
  folderId?: string;
  mimeType?: string;
  /**
   * Narrows to documents carrying this tag.
   *
   * A hit itself carries no tags — the projection is raw SQL over the search
   * index, not the Prisma list select — so this narrows the results without
   * being able to show why each one matched. That is the trade the tag filter
   * makes here and not on the documents list, where the chips are on the rows.
   */
  tagId?: string;
  limit?: number;
  offset?: number;
}

export function searchDocuments(
  token: string,
  q: string,
  options: SearchOptions = {},
): Promise<SearchResults> {
  return apiGet<SearchResults>(
    `/search${query({
      q,
      folderId: options.folderId,
      mimeType: options.mimeType,
      tagId: options.tagId,
      limit: options.limit,
      offset: options.offset,
    })}`,
    token,
  );
}
