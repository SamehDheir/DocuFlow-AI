import {
  BadRequestException,
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
  Res,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import { contextOf } from '../common/http/request-context';
import { contentDisposition } from './content-disposition';
import { DocumentsService, type UploadedFile } from './documents.service';
import { AddVersionDto } from './dto/add-version.dto';
import { ListDocumentsDto } from './dto/list-documents.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @RequirePermissions('documents.create')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFileParam() file: UploadedFile | undefined,
    @Body() dto: UploadDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (!file) {
      throw new BadRequestException(
        apiError(ERROR_CODES.FILE_REQUIRED, 'A file is required', { file: 'Choose a file first' }),
      );
    }

    // companyId comes from the verified JWT, never from the body — it decides
    // which tenant's prefix the object is written under.
    return this.documents.upload(file, dto, user.sub, contextOf(request), user.companyId);
  }

  /**
   * Declared before `:id` on purpose — Nest matches routes in declaration
   * order, so a later `stats` would be swallowed by `:id` and fail UUID parsing.
   */
  @Get('stats')
  @RequirePermissions('documents.read')
  stats() {
    return this.documents.stats();
  }

  /**
   * The caller's own id is passed for favourites, which are per-person rather
   * than per-company. It comes from the verified token; there is deliberately no
   * `?userId=` to read someone else's shortlist with.
   */
  @Get()
  @RequirePermissions('documents.read')
  list(@Query() query: ListDocumentsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.documents.list(query, user.sub);
  }

  @Get(':id')
  @RequirePermissions('documents.read')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documents.findOne(id, user.sub);
  }

  @Get(':id/download')
  @RequirePermissions('documents.read')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.send(id, request, response, false);
  }

  @Get(':id/preview')
  @RequirePermissions('documents.read')
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.send(id, request, response, true);
  }

  @Patch(':id')
  @RequirePermissions('documents.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @Req() request: Request,
  ) {
    return this.documents.update(id, dto, contextOf(request));
  }

  @Delete(':id')
  @RequirePermissions('documents.delete')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.documents.remove(id, contextOf(request));
  }

  @Post(':id/restore')
  @RequirePermissions('documents.restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.documents.restore(id, contextOf(request));
  }

  /**
   * Re-runs OCR and AI analysis.
   *
   * Gated on `documents.update` rather than a new permission: it changes the
   * document's derived data and nothing else, which is the same authority
   * renaming or re-filing it already requires. It is also how documents
   * uploaded before v2 get their text extracted.
   */
  @Post(':id/reprocess')
  @RequirePermissions('documents.update')
  reprocess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.documents.reprocess(id, user.sub, user.companyId, contextOf(request));
  }

  /**
   * Appends a new version and makes it current.
   *
   * Requires BOTH permissions, and PermissionsGuard ANDs the list. It is an
   * upload — it consumes storage and runs the whole extraction pipeline — and
   * it is also a rewrite of what every colleague sees when they open the
   * document. Neither authority alone should be enough.
   */
  @Post(':id/versions')
  @RequirePermissions('documents.create', 'documents.update')
  @UseInterceptors(FileInterceptor('file'))
  addVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFileParam() file: UploadedFile | undefined,
    @Body() dto: AddVersionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    if (!file) {
      throw new BadRequestException(
        apiError(ERROR_CODES.FILE_REQUIRED, 'A file is required', { file: 'Choose a file first' }),
      );
    }

    return this.documents.addVersion(id, file, dto, user.sub, user.companyId, contextOf(request));
  }

  @Post(':id/versions/:versionId/revert')
  @RequirePermissions('documents.create', 'documents.update')
  revertToVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: AddVersionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    return this.documents.revertToVersion(
      id,
      versionId,
      dto,
      user.sub,
      user.companyId,
      contextOf(request),
    );
  }

  /**
   * Download only — no inline preview of an old version.
   *
   * Preview is a hardened surface (see `send` below: sandbox CSP, nosniff, and
   * a client that re-types the blob from its own allowlist). A second inline
   * path doubles that surface for a rare need, so history downloads.
   */
  @Get(':id/versions/:versionId/download')
  @RequirePermissions('documents.read')
  async downloadVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const { stream, version } = await this.documents.openVersionForDownload(
      id,
      versionId,
      contextOf(request),
    );

    response.setHeader('Content-Type', version.mimeType);
    response.setHeader('Content-Length', version.size.toString());
    response.setHeader('Content-Disposition', contentDisposition(version.originalName, false));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");

    stream.pipe(response);
  }

  /**
   * Archive and its inverse.
   *
   * Gated on `documents.update` rather than a permission of their own: archiving
   * is reversible and strictly less destructive than the delete a Member already
   * holds, so a new permission Member lacked would be incoherent.
   */
  @Post(':id/archive')
  @RequirePermissions('documents.update')
  archive(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.documents.archive(id, contextOf(request));
  }

  @Post(':id/unarchive')
  @RequirePermissions('documents.update')
  unarchive(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.documents.unarchive(id, contextOf(request));
  }

  /**
   * Streams stored bytes straight through the API.
   *
   * Deliberately not a presigned MinIO URL. SECURITY.md names a presigned URL
   * that grants access outside the issuing company as the highest-severity bug
   * class here, and a URL cannot be re-checked once it is handed out. Streaming
   * keeps every byte behind the same permission check as every other read —
   * and nginx is already configured for it, with `proxy_buffering off` on this
   * exact route pattern.
   */
  private async send(
    id: string,
    request: Request,
    response: Response,
    inline: boolean,
  ): Promise<void> {
    const { stream, document } = await this.documents.openForDownload(id, contextOf(request), {
      inline,
    });

    response.setHeader('Content-Type', document.mimeType);
    response.setHeader('Content-Length', document.size.toString());
    response.setHeader('Content-Disposition', contentDisposition(document.originalName, inline));

    /**
     * These two matter most on the preview route, which renders user-supplied
     * bytes in the user's own origin: `nosniff` stops a text file being
     * re-interpreted as HTML, and the sandbox directive neuters any script that
     * survives anyway. nginx sets nosniff in production, but development and
     * the e2e suite do not go through nginx.
     */
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");

    stream.pipe(response);
  }
}
