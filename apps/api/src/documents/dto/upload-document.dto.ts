import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';

export const DOCUMENT_NAME_MAX = 255;

/**
 * The text fields that ride alongside the file in a multipart upload.
 *
 * Everything here is optional: a file on its own is a valid upload, and the
 * display name falls back to the original filename. Notably absent are
 * `storageKey`, `size`, `hash` and `status` — all derived server-side. A
 * client-supplied storage key would be a direct cross-tenant read, and the
 * global ValidationPipe's `forbidNonWhitelisted` rejects the attempt outright.
 */
export class UploadDocumentDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(1, DOCUMENT_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(0, 2000)
  description?: string;
}
