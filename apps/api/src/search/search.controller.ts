import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { SearchDto } from './dto/search.dto';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Full-text search across document contents.
   *
   * Gated on `search.read` rather than `documents.read`: searching reads the
   * extracted body of every document in the company, which is a broader reach
   * than opening one document someone already has a link to. Keeping it
   * separate means a role can be given the document list without being given a
   * way to grep the entire archive. All three default roles hold it today; the
   * distinction exists so it can be withdrawn.
   */
  @Get()
  @RequirePermissions('search.read')
  query(@Query() dto: SearchDto) {
    return this.search.search(dto);
  }
}
