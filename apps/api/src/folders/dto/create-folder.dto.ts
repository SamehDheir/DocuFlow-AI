import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';

export const FOLDER_NAME_MAX = 120;

export class CreateFolderDto {
  @IsString()
  @Transform(trimmed)
  @Length(1, FOLDER_NAME_MAX)
  name!: string;

  /**
   * Absent means the company root.
   *
   * There is no `companyId` here, and there never will be: the tenant comes
   * from the JWT. Accepting it from the body is the obvious route to
   * cross-tenant writes, and the global ValidationPipe's `forbidNonWhitelisted`
   * rejects the property outright if a client tries.
   */
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
