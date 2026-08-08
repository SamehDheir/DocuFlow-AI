import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';

/**
 * The body accompanying a new version's file, and the same shape for a revert.
 *
 * Only the note: everything else about a version — its number, its storage key,
 * its size, its type — is derived server-side from the bytes or from the row it
 * is restoring. A client that could name its own version number could rewrite
 * history by claiming one that already exists.
 */
export class AddVersionDto {
  /** What changed, in the uploader's words. Nothing infers it. */
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(0, 500)
  note?: string;
}
