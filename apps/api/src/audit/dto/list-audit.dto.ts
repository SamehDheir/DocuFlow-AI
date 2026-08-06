import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';
import { MAX_PAGE_SIZE } from '../../documents/dto/list-documents.dto';

export class ListAuditDto {
  /** Opaque cursor: the id of the last entry on the previous page. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /** An exact action name, e.g. `document.upload`. */
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  action?: string;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  entityType?: string;

  /**
   * Validated as a string, not a UUID: `audit_logs.entity_id` is a plain text
   * column so that a future action can reference something not keyed by one.
   * Constraining the filter more tightly than the column would be a contract
   * the data does not owe.
   */
  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  /** Inclusive lower bound on `createdAt`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Inclusive upper bound on `createdAt`. */
  @IsOptional()
  @IsDateString()
  to?: string;
}
