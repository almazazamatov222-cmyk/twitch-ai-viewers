import tmi from 'tmi.js';
import { AIService } from './ai';
import { logger } from './logger';

interface BotConfig {
  username: string;
  oauth: string;
  channel: string;
  aiService: AIService;
  shouldHandleVoiceCapture?: boolean;
  botIndex: number;
}

export class Bot {
  private client: tmi.Client | null = null;
  private aiService: AIService;
  private messageCount: number = 0;
  private shouldHandleVoiceCapture: boolean;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private botIndex: number;

  // Ручные сообщения — минимальная пауза 300мс
  private manualQueue: string[] = [];
  private isSendingManual: boolean = false;
  private readonly MANUAL_DELAY = 300;

  // AI сообщения — пауза из MESSAGE_INTERVAL
  private aiQueue: string[] = [];
  private isSendingAI: boolean = false;

  constructor(config: BotConfig) {
    this.aiService = config.aiService;
    this.shouldHandleVoiceCapture = config.shouldHandleVoiceCapture || false;
    this.botIndex = config.botIndex;

    if (!config.oauth.startsWith('oauth:')) {
      throw new Error(`Invalid OAuth token for bot ${config.username}. Must start with 'oauth:'`);
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

    this.client.on('message', async (_channel: string, tags: tmi.ChatUserstate, message: string, self: boolean) => {
      if (self) return;

      const username = tags['display-name'] || tags.username || 'viewer';
      const channelName = (process.env.TWITCH_CHANNEL || '')
        .toLowerCase().replace('https://www.twitch.tv/', '').replace(/\/$/, '');
      const isStreamer = tags.username?.toLowerCase() === channelName;

      // Только первый бот пробрасывает входящие (чтобы не дублировать)
      if (this.botIndex === 0) {
        this.aiService.emit('incomingChat', { username, message, isStreamer, color: tags.color || null });
      }

      if (Math.random() < 0.2) {
        const context = {
          chatMessage: message, username,
          messageCount: this.messageCount, isChatMessage: true,
        };
        this.aiService.emit('chatMessage', JSON.stringify(context));
      }
    });

    this.client.on('connected', (address: string, port: number) => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info(`Bot ${this.client?.getUsername()} connected at ${address}:${port}`);
    });

    this.client.on('disconnected', (reason: string) => {
      this.isConnected = false;
      logger.warn(`Bot ${this.client?.getUsername()} disconnected: ${reason}`);
    });

    this.client.on('logon', () => {
      logger.info(`Bot ${this.client?.getUsername()} logged in`);
    });

    // Каждый бот слушает СВОЙ event: manualMessage_0, manualMessage_1, ...
    this.aiService.on(`manualMessage_${this.botIndex}`, (message: string) => {
      if (message?.trim()) {
        this.manualQueue.push(message);
        this.processManualQueue();
      }
    });

    // AI сообщения — только первый бот отправляет
    if (this.botIndex === 0) {
      this.aiService.on('message', (message: string) => {
        if (message?.trim()) {
          this.aiQueue.push(message);
          this.processAIQueue();
        }
      });
    }
  }

  private async processManualQueue(): Promise<void> {
    if (this.isSendingManual || this.manualQueue.length === 0) return;
    this.isSendingManual = true;
    while (this.manualQueue.length > 0) {
      const msg = this.manualQueue.shift()!;
      try {
        await this.sendMessage(msg);
        this.messageCount++;
      } catch (e) { logger.error('Manual send error:', e); }
      if (this.manualQueue.length > 0) await new Promise(r => setTimeout(r, this.MANUAL_DELAY));
    }
    this.isSendingManual = false;
  }

  private async processAIQueue(): Promise<void> {
    if (this.isSendingAI || this.aiQueue.length === 0) return;
    this.isSendingAI = true;
    const aiDelay = parseInt(process.env.MESSAGE_INTERVAL || '5000');
    while (this.aiQueue.length > 0) {
      const msg = this.aiQueue.shift()!;
      try {
        await this.sendMessage(msg);
        this.messageCount++;
      } catch (e) { logger.error('AI send error:', e); }
      if (this.aiQueue.length > 0) await new Promise(r => setTimeout(r, aiDelay));
    }
    this.isSendingAI = false;
  }

  private async setupVoiceCapture(channel: string): Promise<void> {
    logger.info(`Setting up voice capture for channel: ${channel}`);
    try {
      await this.aiService.startVoiceCapture(channel);
    } catch (error) {
      logger.error('Error setting up voice capture:', error);
    }
  }

  private async sendMessage(message: string): Promise<void> {
    if (!this.client || !message) return;
    const channelUrl = process.env.TWITCH_CHANNEL!;
    const channelName = channelUrl.includes('twitch.tv/')
      ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
      : channelUrl;
    await this.client.say(`#${channelName}`, message);
  }

  public connect(): void {
    if (!this.client) return;
    this.client.connect().catch((e: Error) => logger.error(`Connect error:`, e));
  }

  public disconnect(): void {
    this.manualQueue = [];
    this.aiQueue = [];
    try { this.client?.disconnect(); } catch (e) { }
  }

  public isBotConnected(): boolean { return this.isConnected; }
  public getUsername(): string { return this.client?.getUsername() || ''; }
}
