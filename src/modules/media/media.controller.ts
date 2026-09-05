import { Controller, Get, Param, NotFoundException, GoneException, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiSecurity } from '@nestjs/swagger';
import type { Response } from 'express';
import { InboundMediaService, MediaExpiredError, MediaNotFoundError } from './inbound-media.service';

/**
 * Downloads for attachments delivered by reference (MEDIA_DELIVERY_MODE=storage).
 *
 * Access control is the global API key guard, which also enforces a key's
 * `allowedSessions` because the route exposes `sessionId`. That is why the
 * parameter is named `sessionId` and why the reference is not a bearer-style
 * signed URL: no separate signing secret to store, rotate, or leak, and
 * revoking a key revokes the attachments with it.
 */
@ApiTags('media')
@ApiSecurity('X-API-Key')
@Controller('media')
export class MediaController {
  constructor(private readonly inboundMediaService: InboundMediaService) {}

  @Get(':sessionId/:date/:mediaId')
  @ApiOperation({ summary: 'Download an inbound attachment stored for a session' })
  @ApiResponse({ status: 200, description: 'The attachment' })
  @ApiResponse({ status: 404, description: 'Unknown attachment' })
  @ApiResponse({ status: 410, description: 'The attachment has expired' })
  async download(
    @Param('sessionId') sessionId: string,
    @Param('date') date: string,
    @Param('mediaId') mediaId: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { data, metadata } = await this.inboundMediaService.resolve(sessionId, date, mediaId);

      res.setHeader('Content-Type', metadata.mimetype || 'application/octet-stream');
      res.setHeader('Content-Length', data.length);
      // Always an attachment: the file is arbitrary third-party content, and
      // rendering it inline on the API origin would make it a stored-XSS vector.
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${MediaController.sanitiseFilename(metadata.filename ?? mediaId)}"`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(data);
    } catch (error) {
      if (error instanceof MediaExpiredError) {
        throw new GoneException('Media has expired');
      }
      if (error instanceof MediaNotFoundError) {
        throw new NotFoundException('Media not found');
      }
      throw error;
    }
  }

  /** Keeps a WhatsApp-supplied filename from breaking out of the header. */
  private static sanitiseFilename(filename: string): string {
    const cleaned = filename
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\w.\- ]/g, '_');

    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'attachment';
  }
}
