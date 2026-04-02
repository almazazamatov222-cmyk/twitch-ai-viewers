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
  private botIndex: number;
  private channelName: string;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  private manualQueue: string[] = [];
  private isSendingManual: boolean = false;
  private readonly MANUAL_DELAY = 350;

  private aiQueue: string[] = [];
  private isSendingAI: boolean = false;

  constructor(config: BotConfig) {
    this.aiService = config.aiService;
    this.shouldHandleVoiceCapture = config.shouldHandleVoiceCapture || false;
    this.botIndex = config.botIndex;
    this.channelName = config.channel;

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
      this.setupVoiceCapture(config.channel).catch(err =>
        logger.error(`Voice capture setup error for ${config.username}:`, err)
      );
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on('message', (_ch, tags, message, self) => {
      if (self) return;

      const username = tags['display-name'] || tags.username || 'viewer';
      const channelLower = this.channelName.toLowerCase().replace('https://www.twitch.tv/', '').replace(/\/$/, '');
      const isStreamer = tags.username?.toLowerCase() === channelLower;

      // All bots forward chat — server deduplicates by message ID
      this.aiService.emit('incomingChat', {
        id: tags.id || `${username}-${message}-${Date.now()}`,
        username,
        message,
        isStreamer,
        color: tags.color || null
      });

      if (this.botIndex === 0 && Math.random() < 0.2) {
        this.aiService.emit('chatMessage', JSON.stringify({
          chatMessage: message, username, messageCount: this.messageCount
        }));
      }
    });

    this.client.on('connected', (address, port) => {
      this.isConnected = true;
      logger.info(`Bot[${this.botIndex}] ${this.client?.getUsername()} connected at ${address}:${port}`);
    });

    this.client.on('disconnected', reason => {
      this.isConnected = false;
      logger.warn(`Bot[${this.botIndex}] ${this.client?.getUsername()} disconnected: ${reason}`);
    });

    this.client.on('logon', () =>
      logger.info(`Bot[${this.botIndex}] ${this.client?.getUsername()} logged in`)
    );

    // Each bot listens to its own manual event
    this.aiService.on(`manualMessage_${this.botIndex}`, (message: string) => {
      if (message?.trim()) {
        logger.info(`Bot[${this.botIndex}] queuing: "${message}"`);
        this.manualQueue.push(message);
        this.processManualQueue();
      }
    });

    // AI messages only via bot 0
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
      try { await this.sendMessage(msg); this.messageCount++; }
      catch (e) { logger.error(`Bot[${this.botIndex}] manual send error:`, e); }
      if (this.manualQueue.length > 0) await new Promise(r => setTimeout(r, this.MANUAL_DELAY));
    }
    this.isSendingManual = false;
  }

  private async processAIQueue(): Promise<void> {
    if (this.isSendingAI || this.aiQueue.length === 0) return;
    this.isSendingAI = true;
    const delay = parseInt(process.env.MESSAGE_INTERVAL || '5000');
    while (this.aiQueue.length > 0) {
      const msg = this.aiQueue.shift()!;
      try { await this.sendMessage(msg); this.messageCount++; }
      catch (e) { logger.error(`Bot[${this.botIndex}] AI send error:`, e); }
      if (this.aiQueue.length > 0) await new Promise(r => setTimeout(r, delay));
    }
    this.isSendingAI = false;
  }

  private async setupVoiceCapture(channel: string): Promise<void> {
    logger.info(`Setting up voice capture for channel: ${channel}`);
    try { await this.aiService.startVoiceCapture(channel); }
    catch (error) { logger.error('Error setting up voice capture:', error); }
  }

  private async sendMessage(message: string): Promise<void> {
    if (!this.client || !message) return;
    const channelUrl = process.env.TWITCH_CHANNEL!;
    const ch = channelUrl.includes('twitch.tv/')
      ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
      : channelUrl;
    await this.client.say(`#${ch}`, message);
  }

  public connect(): void {
    if (!this.client) return;
    this.client.connect().catch(e => logger.error(`Bot[${this.botIndex}] connect error:`, e));
  }

  public disconnect(): void {
    this.manualQueue = [];
    this.aiQueue = [];
    try { this.client?.disconnect(); } catch (_) {}
    try { if (this.botIndex === 0) this.aiService.stopVoiceCapture(); } catch (_) {}
  }

  public isBotConnected(): boolean { return this.isConnected; }
  public getUsername(): string { return this.client?.getUsername() || ''; }
  public getBotIndex(): number { return this.botIndex; }
}
