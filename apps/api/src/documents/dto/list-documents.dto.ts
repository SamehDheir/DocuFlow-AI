import { Transform, Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';

/** Page size. 50 keeps the DOM small enough that 10,000 documents stay usable. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Mirrors Prisma's DocumentStatus.
 *
 * Spelled out rather than imported from @prisma/client because class-validator
 * needs a runtime object, and this doubles as the list of statuses the API is
 * willing to filter on.
 */
export enum DocumentStatusFilter {
  CREATED = 'CREATED',
  UPLOADING = 'UPLOADING',
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  OCR = 'OCR',
  AI_ANALYSIS = 'AI_ANALYSIS',
  READY = 'READY',
  ARCHIVED = 'ARCHIVED',
  DELETED = 'DELETED',
}

export class ListDocumentsDto {
  /**
   * `?folderId=` (empty) means the company root; omitting it means "anywhere".
   * Those are genuinely different questions, so they need different spellings.
   */
  @IsOptional()
  @IsString()
  folderId?: string;

  @IsOptional()
  @IsEnum(DocumentStatusFilter)
  status?: DocumentStatusFilter;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  q?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsUUID()
  ownerId?: string;

  /** Narrows to documents carrying this tag. */
  @IsOptional()
  @IsUUID()
  tagId?: string;

  /** Opaque cursor: the id of the last document on the previous page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /** `true` inverts the soft-delete filter, listing the trash instead. */
  @IsOptional()
  @IsBooleanString()
  trash?: string;

  /**
   * `true` puts archived documents back in the results.
   *
   * They are hidden by default, which is the entire point of archiving — a
   * status that changed nothing about what you see would not be worth setting.
   * Asking for `?status=ARCHIVED` explicitly also returns them, so there are two
   * ways to see an archive: alongside everything else, or on its own.
   */
  @IsOptional()
  @IsBooleanString()
  includeArchived?: string;

  /**
   * `true` narrows to the caller's own favourites.
   *
   * There is no `?userId=` to pair it with, on purpose: a favourite is a private
   * bookmark, and the only shortlist this endpoint will show you is your own.
   */
  @IsOptional()
  @IsBooleanString()
  favorite?: string;
}
