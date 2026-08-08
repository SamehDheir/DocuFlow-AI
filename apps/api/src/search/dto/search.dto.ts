import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';

export class SearchDto {
  /**
   * The search term.
   *
   * Length-capped: the value is bound as a parameter so it is not an injection
   * risk, but an unbounded string still becomes a tsquery the planner has to
   * build, and that is a cheap way to make the database do expensive work.
   */
  @IsString()
  @MaxLength(200)
  q!: string;

  /**
   * Empty string means "documents at the root", matching the documents list.
   * ValidateIf lets '' through, which @IsUUID alone would reject.
   */
  @IsOptional()
  @ValidateIf((_object, value) => value !== '')
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  /** Narrows to documents carrying this tag. */
  @IsOptional()
  @IsUUID()
  tagId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  offset?: number;
}
