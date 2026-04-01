import tmi from 'tmi.js';
import { AIService } from './ai';
import { logger } from './logger';

interface BotConfig {
  username: string;
  oauth: string;
  channel: string;
  aiService: AIService;
  shouldHandleVoiceCapture?: boolean;
}

export class Bot {
  private client: tmi.Client | null = null;
  private aiService: AIService;
  private lastMessageTime: number = 0;
  private messageCount: number = 0;
  private shouldHandleVoiceCapture: boolean;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(config: BotConfig) {
    this.aiService = config.aiService;
    this.shouldHandleVoiceCapture = config.shouldHandleVoiceCapture || false;

    if (!config.oauth.startsWith('oauth:')) {
      throw new Error(`Invalid OAuth token format for bot ${config.username}. Token must start with 'oauth:'`);
    }

    this.client = new tmi.Client({
      options: { debug: false, messagesLogLevel: "info" },
      identity: { username: config.username, password: config.oauth },
      channels: [config.channel],
      connection: { reconnect: true, maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS, secure: true }
    });

    this.setupEventHandlers();

    if (this.shouldHandleVoiceCapture) {
      this.setupVoiceCapture(config.channel).catch(error => {
        logger.error(`Error setting up voice capture for bot ${config.username}:`, error);
      });
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('message', async (channel: string, tags: tmi.ChatUserstate, message: string, self: boolean) => {
      if (self) return;

      const username = tags['display-name'] || tags.username || 'viewer';
      const channelName = process.env.TWITCH_CHANNEL?.toLowerCase().replace('https://www.twitch.tv/', '');
      const isStreamer = tags.username?.toLowerCase() === channelName;

      // Пробрасываем ВСЕ входящие сообщения на дашборд
      this.aiService.emit('incomingChat', {
        username,
        message,
        isStreamer,
        color: tags.color || null
      });

      try {
        const context = {
          streamInfo: this.aiService.currentChannelInfo,
          chatMessage: message,
          username,
          timeSinceLastMessage: Date.now() - this.lastMessageTime,
          messageCount: this.messageCount,
          isChatMessage: true,
        };
        if (Math.random() < 0.2) {
          this.aiService.emit('chatMessage', JSON.stringify(context));
        }
      } catch (error) {
        logger.error(`Error handling message:`, error);
      }
    });

    this.client.on('connected', (address: string, port: number) => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info(`Bot ${this.client?.getUsername()} connected to chat at ${address}:${port}`);
    });

    this.client.on('disconnected', (reason: string) => {
      this.isConnected = false;
      logger.warn(`Bot ${this.client?.getUsername()} disconnected: ${reason}`);
    });

    this.client.on('reconnect', () => {
      this.reconnectAttempts++;
      logger.info(`Bot ${this.client?.getUsername()} reconnecting (${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
    });

    this.client.on('logon', () => {
      logger.info(`Bot ${this.client?.getUsername()} successfully logged in`);
    });

    this.aiService.on('message', (message: string) => {
      if (message && message.trim() !== '') {
        const now = Date.now();
        if (now - this.lastMessageTime >= 5000) {
          logger.info('Sending message:', message);
          this.sendMessage(message).catch(error => {
            logger.error(`Error sending message from ${this.client?.getUsername()}:`, error);
          });
          this.messageCount++;
          this.lastMessageTime = now;
        } else {
          logger.info('Skipping message - too soon since last message');
        }
      }
    });
  }

  private async setupVoiceCapture(channel: string): Promise<void> {
    logger.info(`Setting up voice capture for channel: ${channel}`);
    try {
      await this.aiService.startVoiceCapture(channel);
      let attempts = 0;
      while (!this.aiService.currentChannelInfo && attempts < 5) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
      }
      if (this.aiService.currentChannelInfo) {
        logger.info('Channel info available:', {
          title: this.aiService.currentChannelInfo.title,
          game: this.aiService.currentChannelInfo.gameName,
        });
      }
    } catch (error) {
      logger.error('Error setting up voice capture:', error);
    }
  }

  private async sendMessage(message: string): Promise<void> {
    if (!this.client || !message) return;
    try {
      const channelUrl = process.env.TWITCH_CHANNEL!;
      const channelName = channelUrl.includes('twitch.tv/')
        ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
        : channelUrl;
      await this.client.say(`#${channelName}`, message);
    } catch (error) {
      logger.error(`Error sending message from ${this.client?.getUsername()}:`, error);
    }
  }

  public connect(): void {
    if (!this.client) return;
    logger.info(`Connecting bot ${this.client.getUsername()}...`);
    this.client.connect().catch((error: Error) => {
      logger.error(`Failed to connect bot ${this.client?.getUsername()}:`, error);
    });
  }

  public disconnect(): void {
    if (!this.client) return;
    logger.info(`Disconnecting bot ${this.client.getUsername()}...`);
    try {
      this.client.disconnect();
      this.aiService.stopVoiceCapture();
    } catch (error) {
      logger.error(`Error disconnecting bot ${this.client.getUsername()}:`, error);
    }
  }

  public isBotConnected(): boolean {
    return this.isConnected;
  }

  public getUsername(): string {
    return this.client?.getUsername() || '';
  }
}
