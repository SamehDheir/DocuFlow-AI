import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contextOf } from '../common/http/request-context';
import { CreateTagDto, SetDocumentTagsDto, UpdateTagDto } from './dto/tag.dto';
import { TagsService } from './tags.service';

/**
 * No controller prefix: the routes live under two different resources, the way
 * ApprovalsController already does.
 *
 * Managing the vocabulary is `/tags`. Applying it is `/documents/:id/tags`,
 * because that is a change to the document — and it is gated on
 * `documents.update`, whose catalogue description has promised "re-tag" since
 * v1 without anything to back it up.
 */
@Controller()
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get('tags')
  @RequirePermissions('tags.read')
  list() {
    return this.tags.list();
  }

  @Post('tags')
  @RequirePermissions('tags.manage')
  create(@Body() dto: CreateTagDto, @Req() request: Request) {
    return this.tags.create(dto, contextOf(request));
  }

  @Patch('tags/:id')
  @RequirePermissions('tags.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTagDto,
    @Req() request: Request,
  ) {
    return this.tags.update(id, dto, contextOf(request));
  }

  @Delete('tags/:id')
  @RequirePermissions('tags.manage')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.tags.remove(id, contextOf(request));
  }

  /**
   * PUT, not PATCH: this replaces the whole set rather than applying a delta.
   *
   * Gated on `documents.update` rather than `tags.manage`. Labelling a document
   * is ordinary document work; inventing a label everyone else will see is the
   * privileged half, so a Member can tag freely from the vocabulary but cannot
   * quietly fork it into near-duplicates.
   */
  @Put('documents/:id/tags')
  @RequirePermissions('documents.update')
  setForDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetDocumentTagsDto,
    @Req() request: Request,
  ) {
    return this.tags.setForDocument(id, dto, contextOf(request));
  }
}
