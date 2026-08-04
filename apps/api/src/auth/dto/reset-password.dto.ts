import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @MinLength(1, { message: 'Reset token is required' })
  @MaxLength(255)
  token!: string;

  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(72)
  password!: string;
}
