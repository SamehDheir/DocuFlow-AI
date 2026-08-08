import { apiGet, apiSend } from './api';
import type { DocumentTag } from './documents';

/**
 * The labelling layer.
 *
 * Split from `documents.ts` because the vocabulary is a resource of its own —
 * `/tags` is company-wide and read by the filter bar, the picker and the bulk
 * bar alike, while `PUT /documents/:id/tags` is a change to one document. Both
 * live here so the two halves of "tagging" cannot drift apart in how they parse
 * a colour or order a list.
 *
 * Every call takes an access token explicitly, to be wrapped in
 * `useSession().withToken(...)`.
 */

/**
 * The palette, mirroring the API's `TagColor` enum.
 *
 * Token names, never hex — `Badge` maps each to a fill, a border and a
 * foreground that both themes can satisfy. A literal colour in the database
 * would be the one colour in the product no theme could reach.
 */
export const TAG_COLORS = ['neutral', 'accent', 'success', 'warning', 'danger'] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/** A tag with its usage count, as `GET /api/tags` returns it. */
export interface TagListItem extends DocumentTag {
  createdAt: string;
  /**
   * Documents currently carrying it, excluding trashed and archived ones — so
   * the number agrees with what selecting the tag actually lists.
   */
  documentCount: number;
}

/**
 * The whole company vocabulary, unpaginated and sorted by name.
 *
 * Unpaginated because a tag list that needs paging cannot be used as a filter,
 * and `@@unique([companyId, name])` keeps it bounded by how many distinct
 * labels a company has bothered to invent.
 */
export function listTags(token: string): Promise<TagListItem[]> {
  return apiGet<TagListItem[]>('/tags', token);
}

/** Needs `tags.manage` — inventing a label everyone will see is the privileged half. */
export function createTag(
  token: string,
  input: { name: string; color?: TagColor },
): Promise<DocumentTag> {
  return apiSend<DocumentTag>('POST', '/tags', token, input);
}

/*
 * PATCH /tags/:id and DELETE /tags/:id are deliberately NOT wrapped here.
 *
 * Nothing in the web renders a tag-management screen, so a client for either
 * would be an export with no caller — and dormant code is the pattern this
 * codebase has already been bitten by: `Tag` and `DocumentTag` sat in the schema
 * through three releases with nothing behind them. The routes exist and are
 * tested at the API; the two functions arrive with the screen that needs them.
 * Recorded in NEXT_STEPS.md so the gap is a decision rather than an oversight.
 */

/**
 * Replaces a document's tags with exactly this set.
 *
 * A whole-set PUT, not a delta: repeating it is idempotent, and two people
 * editing one document's tags at once cannot interleave into a combination
 * neither of them chose. An empty array is valid and means "no tags" — unlike
 * roles, where an empty set cannot be told apart from a bug.
 *
 * Gated on `documents.update`, not `tags.manage`. The bulk equivalent in
 * `documents.ts` IS a delta, deliberately; see the note there.
 */
export function setDocumentTags(
  token: string,
  documentId: string,
  tagIds: string[],
): Promise<DocumentTag[]> {
  return apiSend<DocumentTag[]>('PUT', `/documents/${documentId}/tags`, token, { tagIds });
}
