import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';
import { FOLDER_NAME_MAX } from './create-folder.dto';

export class UpdateFolderDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(1, FOLDER_NAME_MAX)
  name?: string;

  /**
   * Three-state on purpose:
   *   absent → leave the folder where it is
   *   null   → move it to the company root
   *   uuid   → move it under that folder
   *
   * `null` has to be distinguishable from "not sent", or moving a folder back
   * to the root becomes impossible to express.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parentId?: string | null;
}
