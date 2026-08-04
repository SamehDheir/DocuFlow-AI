import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { normaliseEmail, trimmed } from './transforms';

export class RegisterDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(2, { message: 'Company name must be at least 2 characters' })
  @MaxLength(120)
  companyName!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'First name is required' })
  @MaxLength(80)
  firstName!: string;

  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Last name is required' })
  @MaxLength(80)
  lastName!: string;

  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email!: string;

  /**
   * 12 characters minimum, matching the policy the register form already
   * enforces client-side. The 72-character ceiling is bcrypt's: it ignores
   * everything past 72 bytes, so accepting more would silently make two
   * different long passwords interchangeable.
   */
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(72)
  password!: string;
}
