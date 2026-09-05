import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter, MessageFilterConfig } from './adapters/whatsapp-web-js.adapter';
import { PluginLoaderService, PluginType, IEnginePlugin, PluginManifest } from '../core/plugins';
import { WhatsAppWebJsPlugin } from '../plugins/engines/whatsapp-web-js';
import { createLogger } from '../common/services/logger.service';

export interface EngineCreateOptions {
  sessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

@Injectable()
export class EngineFactory implements OnModuleInit {
  private readonly logger = createLogger('EngineFactory');
  private readonly engineType: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly pluginLoader: PluginLoaderService,
  ) {
    this.engineType = this.configService.get<string>('engine.type') ?? 'whatsapp-web.js';
  }

  async onModuleInit(): Promise<void> {
    // Register built-in engine plugins
    await this.registerBuiltInEngines();
  }

  private async registerBuiltInEngines(): Promise<void> {
    // Register WhatsApp-web.js as built-in plugin
    const wwjsManifest: PluginManifest = {
      id: 'whatsapp-web.js',
      name: 'WhatsApp Web.js Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Official WhatsApp-web.js engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };

    const wwjsPlugin = new WhatsAppWebJsPlugin();
    this.pluginLoader.registerBuiltInPlugin(wwjsManifest, wwjsPlugin);

    // Auto-enable the configured engine
    try {
      await this.pluginLoader.enablePlugin(this.engineType);
      this.logger.log(`Engine plugin enabled: ${this.engineType}`, {
        action: 'engine_enabled',
        engineType: this.engineType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enable engine plugin: ${this.engineType}`,
        error instanceof Error ? error.message : String(error),
        { action: 'engine_enable_failed' },
      );
    }
  }

  /**
   * Inbound filtering resolved from app config. Passed explicitly to the engine
   * for the same reason sessionDataPath is: the plugin context carries no
   * runtime config, so a plugin-created engine would otherwise silently fall
   * back to its own defaults and download every status the account receives.
   */
  private getMessageFilterConfig(): MessageFilterConfig {
    return {
      ignoreStatus: this.configService.get<boolean>('engine.messages.ignoreStatus'),
      ignoreNewsletters: this.configService.get<boolean>('engine.messages.ignoreNewsletters'),
      ignoreBroadcasts: this.configService.get<boolean>('engine.messages.ignoreBroadcasts'),
      ignoreGroups: this.configService.get<boolean>('engine.messages.ignoreGroups'),
      media: {
        download: this.configService.get<boolean>('engine.messages.media.download'),
        maxBytes: this.configService.get<number>('engine.messages.media.maxBytes'),
        allowedTypes: this.configService.get<string[]>('engine.messages.media.allowedTypes'),
        unknownSizePolicy: this.configService.get<'skip' | 'download'>('engine.messages.media.unknownSizePolicy'),
      },
    };
  }

  create(options: EngineCreateOptions): IWhatsAppEngine {
    // Try to get engine from plugin system
    const enginePlugin = this.pluginLoader.getPlugin(this.engineType);

    if (enginePlugin?.instance && this.isEnginePlugin(enginePlugin.instance)) {
      return enginePlugin.instance.createEngine({
        sessionId: options.sessionId,
        proxyUrl: options.proxyUrl,
        proxyType: options.proxyType,
        // The plugin context carries no runtime config, so the resolved engine
        // settings must be passed explicitly; otherwise the plugin falls back
        // to './data/sessions' and writes credentials somewhere the session
        // layer never looks when it has to wipe them.
        sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
        headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
        puppeteerArgs: this.configService.get<string[]>('engine.puppeteer.args'),
        initTimeout: this.configService.get<number>('engine.initTimeout') ?? 90000,
        messages: this.getMessageFilterConfig(),
      }) as IWhatsAppEngine;
    }

    // Fallback to direct adapter creation (legacy support)
    this.logger.warn(`Engine plugin ${this.engineType} not available, using fallback`, {
      action: 'engine_fallback',
    });

    return this.createFallbackEngine(options);
  }

  private isEnginePlugin(instance: unknown): instance is IEnginePlugin {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'type' in instance &&
      instance.type === PluginType.ENGINE &&
      'createEngine' in instance &&
      typeof (instance as { createEngine: unknown }).createEngine === 'function'
    );
  }

  private createFallbackEngine(options: EngineCreateOptions): IWhatsAppEngine {
    // Legacy direct creation (fallback)
    return new WhatsAppWebJsAdapter({
      sessionId: options.sessionId,
      sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
      puppeteer: {
        headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
        args: this.configService.get<string[]>('engine.puppeteer.args') ?? ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      proxy: options.proxyUrl
        ? {
            url: options.proxyUrl,
            type: options.proxyType ?? 'http',
          }
        : undefined,
      initTimeout: this.configService.get<number>('engine.initTimeout') ?? 90000,
      messages: this.getMessageFilterConfig(),
    });
  }

  // ============================================================================
  // Query Methods for API/Dashboard
  // ============================================================================

  getAvailableEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    const enginePlugins = this.pluginLoader.getPluginsByType(PluginType.ENGINE);

    return enginePlugins.map(plugin => {
      const features = plugin.instance && this.isEnginePlugin(plugin.instance) ? plugin.instance.getFeatures() : [];

      return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        enabled: this.pluginLoader.isPluginEnabled(plugin.manifest.id),
        features,
      };
    });
  }

  getCurrentEngine(): string {
    return this.engineType;
  }
}
