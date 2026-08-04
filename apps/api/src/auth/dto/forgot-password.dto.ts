import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';
import { normaliseEmail } from './transforms';

export class ForgotPasswordDto {
  @Transform(normaliseEmail)
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email!: string;
}
