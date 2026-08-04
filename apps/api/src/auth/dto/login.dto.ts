import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { normaliseEmail } from './transforms';

export class LoginDto {
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email!: string;

  /**
   * Deliberately not held to the registration policy. Tightening it here would
   * reject accounts created before the policy changed, and a login form that
   * rejects the password a user actually has is worse than one that checks it.
   */
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  @MaxLength(72)
  password!: string;
}
