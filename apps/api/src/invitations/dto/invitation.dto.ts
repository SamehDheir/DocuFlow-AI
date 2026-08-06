import { IsEmail, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  /** Which role the invitee lands on. Validated against the company's own roles. */
  @IsUUID()
  roleId!: string;
}

export class AcceptInvitationDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  /**
   * Mirrors RegisterDto's rule rather than inventing a second one. An invited
   * account is a full account and must not be easier to guess than a founder's.
   */
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
