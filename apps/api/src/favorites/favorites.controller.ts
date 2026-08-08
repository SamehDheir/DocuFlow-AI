import { Controller, Delete, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { FavoritesService } from './favorites.service';

/**
 * Starring a document.
 *
 * `@Controller('documents')` rather than a prefix of its own: the star belongs
 * to the document from the client's point of view, and `/favorites/:documentId`
 * would invent a resource with no identity beyond the pair it names.
 *
 * There is no list endpoint here — `GET /api/documents?favorite=true` already
 * answers it, and composes with the folder, tag and status filters that a
 * separate `/favorites` collection would each have to grow its own copy of.
 *
 * NOTE ON ROUTE ORDER: both routes are two segments (`:id/favorite`), so they
 * cannot shadow, or be shadowed by, the bulk routes in
 * BulkDocumentsController — those are all `bulk/<action>`, and `bulk` is not a
 * UUID. DocumentsController's `:id/...` handlers are the ones that have to be
 * declared after bulk; see the note there.
 */
@Controller('documents')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Post(':id/favorite')
  @RequirePermissions('documents.read')
  add(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.favorites.add(id, user.sub);
  }

  @Delete(':id/favorite')
  @RequirePermissions('documents.read')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.favorites.remove(id, user.sub);
  }
}
