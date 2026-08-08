import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contextOf } from '../common/http/request-context';
import { CommentsService } from './comments.service';
import { CreateCommentDto, ListCommentsDto, UpdateCommentDto } from './dto/comment.dto';

/**
 * No controller prefix: the routes live under two resources, as TagsController
 * and ApprovalsController already do.
 *
 * A thread belongs to a document, so reading and posting hang off
 * `/documents/:id/comments`. Editing and deleting name the comment itself —
 * there is nothing the document id would add to `/comments/:id`, and carrying it
 * would invite a handler that trusts the path over the row.
 *
 * `documents.read` is required on every route including the writes: a
 * conversation you cannot open the document for is not one you should be able to
 * join. PermissionsGuard ANDs the list, so both must hold.
 */
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('documents/:id/comments')
  @RequirePermissions('documents.read')
  forDocument(@Param('id', ParseUUIDPipe) id: string, @Query() dto: ListCommentsDto) {
    return this.comments.forDocument(id, dto);
  }

  @Post('documents/:id/comments')
  @RequirePermissions('documents.read', 'comments.create')
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.comments.create(id, dto, user.sub, user.companyId, contextOf(request));
  }

  /**
   * Editing asks only for the permission to take part. The service restricts it
   * to the author — including against a moderator, who may delete a comment but
   * never rewrite one.
   */
  @Patch('comments/:id')
  @RequirePermissions('documents.read', 'comments.create')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.comments.update(id, dto, user.sub, user.companyId, contextOf(request));
  }

  /**
   * Deliberately NOT gated on `comments.moderate`.
   *
   * That would stop a Member deleting their own remark, which is the common
   * case. The guard can only AND a fixed list, so "the author, or a moderator"
   * is decided in the service — this route asks for what everyone in a
   * conversation holds.
   */
  @Delete('comments/:id')
  @RequirePermissions('documents.read', 'comments.create')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.comments.remove(id, user.sub, user.companyId, contextOf(request));
  }
}
