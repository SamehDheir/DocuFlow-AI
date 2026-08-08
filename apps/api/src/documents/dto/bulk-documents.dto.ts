import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';

/**
 * The cap on one batch.
 *
 * Chosen against the page size rather than plucked from the air: the list serves
 * at most `MAX_PAGE_SIZE` (100) rows, so "select all on this page" fits twice
 * over. Beyond that a caller is scripting rather than clicking, and each id
 * costs a row in `audit_logs` — a request that could write ten thousand of them
 * is a denial-of-service against the trail the product exists to keep.
 */
export const MAX_BULK_IDS = 200;

export class BulkDocumentsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BULK_IDS)
  @IsUUID('4', { each: true })
  ids!: string[];
}

export class BulkMoveDocumentsDto extends BulkDocumentsDto {
  /**
   * null moves the selection to the company root; a uuid files it into that
   * folder. Unlike `UpdateDocumentDto`, "absent" is not a third state — a move
   * that names no destination is not a move.
   */
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  folderId!: string | null;
}

/**
 * A DELTA, deliberately — unlike `PUT /api/documents/:id/tags`, which replaces
 * the whole set.
 *
 * Whole-set semantics across a selection would clear labels the caller never
 * saw. Tagging twenty documents at once means "these twenty now also carry
 * Urgent", not "these twenty now carry Urgent and nothing else", and the second
 * reading destroys work on rows nobody inspected. The single-document route can
 * afford replacement because its form shows what is there first.
 */
export class BulkTagDocumentsDto extends BulkDocumentsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  add?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  remove?: string[];
}
