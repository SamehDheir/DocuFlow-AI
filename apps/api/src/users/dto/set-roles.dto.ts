import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class SetRolesDto {
  /**
   * The member's roles after this call — a replacement, not an addition.
   *
   * Non-empty by validation rather than by convention: a member with no roles
   * has no permissions at all and cannot be told apart from a bug, so if the
   * intent is to remove someone's access the honest operation is to deactivate
   * the account, not to leave them holding nothing.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  roleIds!: string[];
}
