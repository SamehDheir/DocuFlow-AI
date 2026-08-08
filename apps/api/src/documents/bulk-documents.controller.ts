import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contextOf } from '../common/http/request-context';
import { BulkDocumentsService } from './bulk-documents.service';
import {
  BulkDocumentsDto,
  BulkMoveDocumentsDto,
  BulkTagDocumentsDto,
} from './dto/bulk-documents.dto';

/**
 * Acting on a selection.
 *
 * ONE ROUTE PER ACTION, not a single endpoint taking an action name. The
 * permission differs per action — deleting needs `documents.delete`, restoring
 * needs `documents.restore`, the rest need `documents.update` — and a single
 * endpoint would have to either demand the strictest of them or check
 * authorisation inside the service. Both are worse: the first stops a Member
 * bulk-deleting documents they can delete one at a time, and the second moves
 * authorisation out of the guard that every other route in this system uses.
 *
 * ROUTE ORDER IS LOAD-BEARING. These paths are `documents/bulk/<action>`, and
 * DocumentsController declares `@Post(':id/restore')` — a two-segment pattern
 * that matches `documents/bulk/restore` with `:id` bound to the literal string
 * "bulk". Express resolves by registration order, and Nest registers controllers
 * in the order the module lists them, so DocumentsModule lists this one FIRST.
 * `bulk.e2e-spec.ts` asserts the shadowing has not come back: without the
 * ordering, every route here returns a UUID validation error from ParseUUIDPipe
 * rather than doing anything.
 *
 * Every action returns 200 with a per-id report rather than failing the batch on
 * one stale row. See BulkDocumentsService for why.
 */
@Controller('documents/bulk')
export class BulkDocumentsController {
  constructor(private readonly bulk: BulkDocumentsService) {}

  @Post('delete')
  @RequirePermissions('documents.delete')
  remove(@Body() dto: BulkDocumentsDto, @Req() request: Request) {
    return this.bulk.remove(dto, contextOf(request));
  }

  @Post('restore')
  @RequirePermissions('documents.restore')
  restore(@Body() dto: BulkDocumentsDto, @Req() request: Request) {
    return this.bulk.restore(dto, contextOf(request));
  }

  @Post('archive')
  @RequirePermissions('documents.update')
  archive(@Body() dto: BulkDocumentsDto, @Req() request: Request) {
    return this.bulk.archive(dto, contextOf(request));
  }

  @Post('unarchive')
  @RequirePermissions('documents.update')
  unarchive(@Body() dto: BulkDocumentsDto, @Req() request: Request) {
    return this.bulk.unarchive(dto, contextOf(request));
  }

  @Post('move')
  @RequirePermissions('documents.update')
  move(@Body() dto: BulkMoveDocumentsDto, @Req() request: Request) {
    return this.bulk.move(dto, contextOf(request));
  }

  /**
   * `documents.update`, not `tags.manage` — the same split the single-document
   * route makes. Labelling documents is ordinary document work; inventing a
   * label the whole company then sees is the privileged half, and nothing here
   * creates a tag.
   */
  @Post('tags')
  @RequirePermissions('documents.update')
  setTags(@Body() dto: BulkTagDocumentsDto, @Req() request: Request) {
    return this.bulk.setTags(dto, contextOf(request));
  }
}
