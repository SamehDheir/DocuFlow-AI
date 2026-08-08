import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { trimmed } from '../../auth/dto/transforms';

export const TAG_NAME_MAX = 40;

/**
 * The tag palette, as design-token names rather than colours.
 *
 * `Tag.color` stores one of these strings and the web maps it to classes from
 * the token layer — the same five tones `Badge` already uses. Storing a hex
 * would put a literal colour in the database, where no theme can reach it: the
 * value would have to work in both light and dark, and it would be the one
 * colour in the product that drifts when the palette moves.
 *
 * Widening this palette is a token change, not a database change.
 */
export enum TagColor {
  NEUTRAL = 'neutral',
  ACCENT = 'accent',
  SUCCESS = 'success',
  WARNING = 'warning',
  DANGER = 'danger',
}

export class CreateTagDto {
  @IsString()
  @Transform(trimmed)
  @Length(1, TAG_NAME_MAX)
  name!: string;

  @IsOptional()
  @IsEnum(TagColor)
  color?: TagColor;
}

export class UpdateTagDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @Length(1, TAG_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsEnum(TagColor)
  color?: TagColor;
}

/**
 * The whole set a document should carry, not a delta.
 *
 * Same shape and same reasoning as `PUT /api/users/:id/roles`: sending the
 * complete set makes the call idempotent, and two people editing tags at once
 * cannot interleave into a combination neither of them chose.
 *
 * Unlike roles, an empty array IS valid. Removing every tag is a real intention,
 * whereas a member with no roles cannot be told apart from a bug.
 */
export class SetDocumentTagsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  tagIds!: string[];
}
