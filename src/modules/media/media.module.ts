import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InboundMediaService } from './inbound-media.service';
import { MediaController } from './media.controller';

/**
 * Global because SessionService applies the delivery mode on the inbound path,
 * and StorageModule (its only dependency) is global for the same reason.
 */
@Global()
@Module({
  imports: [ConfigModule],
  controllers: [MediaController],
  providers: [InboundMediaService],
  exports: [InboundMediaService],
})
export class MediaModule {}
