import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { FoldersService } from './folders.service';

@Controller('folders')
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Post()
  @RequirePermissions('folders.create')
  create(
    @Body() dto: CreateFolderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.folders.create(dto, user.sub, contextOf(request));
  }

  /**
   * `?parentId=` (empty) lists the root level; omitting it entirely returns
   * every folder in the company, which is what the sidebar builds its tree from.
   */
  @Get()
  @RequirePermissions('folders.read')
  list(@Query('parentId') parentId?: string) {
    if (parentId === undefined) {
      return this.folders.list();
    }

    return this.folders.list(parentId === '' ? null : parentId);
  }

  @Get(':id')
  @RequirePermissions('folders.read')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.folders.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('folders.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFolderDto,
    @Req() request: Request,
  ) {
    return this.folders.update(id, dto, contextOf(request));
  }

  @Delete(':id')
  @RequirePermissions('folders.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    await this.folders.remove(id, contextOf(request));
  }
}
