import { Transform } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Matches the page size the documents list uses, so the UI paginates alike. */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;

export class ListNotificationsDto {
  /** Cursor pagination, keyed on the previous page's last id. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  // Capped so one request cannot ask for an unbounded page.
  @Max(100)
  limit?: number;

  /** Query strings are text; 'true' | 'false' rather than a coerced boolean. */
  @IsOptional()
  @IsBooleanString()
  unreadOnly?: string;
}
