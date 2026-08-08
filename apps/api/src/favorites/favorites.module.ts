import { Module } from '@nestjs/common';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';

/**
 * No AuditModule import, unlike every other module that writes: a favourite is
 * a private bookmark, not a change to the document. See the service.
 */
@Module({
  controllers: [FavoritesController],
  providers: [FavoritesService],
  exports: [FavoritesService],
})
export class FavoritesModule {}
