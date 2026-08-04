import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';
import { DOCUMENT_NAME_MAX } from './upload-document.dto';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(1, DOCUMENT_NAME_MAX)
  name?: string;

  /**
   * absent → leave it where it is, null → move to the root, uuid → move into
   * that folder. Same three-state shape as UpdateFolderDto, for the same
   * reason: "not sent" and "move to root" cannot share a spelling.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  folderId?: string | null;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(0, DOCUMENT_NAME_MAX)
  title?: string;
}
