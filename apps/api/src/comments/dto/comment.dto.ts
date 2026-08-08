import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';

/**
 * Long enough for a paragraph of reasoning, short enough that nobody mistakes
 * the thread for the archive. A comment is a remark ABOUT a document; anything
 * that wants to be a document has somewhere better to live.
 */
export const COMMENT_BODY_MAX = 4000;

/** Threads are short. A page that usually covers the whole discussion is the point. */
export const DEFAULT_COMMENT_PAGE_SIZE = 30;

export class CreateCommentDto {
  /**
   * Trimmed before length validation, so a body of nothing but whitespace is
   * refused rather than stored as an empty bubble.
   */
  @IsString()
  @Transform(trimmed)
  @Length(1, COMMENT_BODY_MAX)
  body!: string;
}

/**
 * Editing replaces the body outright. There is no partial edit to express, and
 * a comment with every field optional would accept `{}` as a valid rewrite.
 */
export class UpdateCommentDto {
  @IsString()
  @Transform(trimmed)
  @Length(1, COMMENT_BODY_MAX)
  body!: string;
}

export class ListCommentsDto {
  /** Cursor pagination, keyed on the previous page's last id. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
