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

  private manualQueue: string[] = [];
  private isSendingManual = false;
  private aiQueue: string[] = [];
  private isSendingAI = false;

  constructor(config: BotConfig) {
    this.aiService = config.aiService;
    this.shouldHandleVoiceCapture = config.shouldHandleVoiceCapture || false;
    this.botIndex = config.botIndex;
    this.channelName = config.channel;

    if (!config.oauth.startsWith('oauth:'))
      throw new Error(`Invalid OAuth for ${config.username} - must start with 'oauth:'`);

    this.client = new tmi.Client({
      options: { debug: false, messagesLogLevel: 'info' },
      identity: { username: config.username, password: config.oauth },
      channels: [config.channel],
      connection: { reconnect: true, maxReconnectAttempts: 5, secure: true }
    });

    this.setupEventHandlers();
    if (this.shouldHandleVoiceCapture)
      this.setupVoiceCapture(config.channel).catch(e => logger.error('Voice capture error:', e));
  }

  private setupEventHandlers() {
    if (!this.client) return;

    // Only bot[0] reads chat (no duplicates)
    if (this.botIndex === 0) {
      this.client.on('message', (_ch, tags, message, self) => {
        if (self) return;
        const username = tags['display-name'] || tags.username || 'viewer';
        const chLower = this.channelName.toLowerCase()
          .replace(/^https?:\/\/www\.twitch\.tv\//, '').replace(/\/$/, '');
        const isStreamer = (tags.username || '').toLowerCase() === chLower;
        this.aiService.emit('incomingChat', { id: tags.id, username, message, isStreamer, color: tags.color });
        if (Math.random() < 0.15)
          this.aiService.emit('chatMessage', JSON.stringify({ chatMessage: message, username }));
      });
    }

    this.client.on('connected', (addr, port) => {
      this.isConnected = true;
      logger.info(`Bot[${this.botIndex}] ${this.client?.getUsername()} connected at ${addr}:${port}`);
    });
    this.client.on('disconnected', r => {
      this.isConnected = false;
      logger.warn(`Bot[${this.botIndex}] ${this.client?.getUsername()} disconnected: ${r}`);
    });
    this.client.on('logon', () =>
      logger.info(`Bot[${this.botIndex}] ${this.client?.getUsername()} logged in`)
    );

    // Dashboard manual messages
    this.aiService.on(`manualMessage_${this.botIndex}`, (msg: string) => {
      if (msg?.trim()) { this.manualQueue.push(msg); this.processManualQueue(); }
    });
  }

  // Called by main.ts round-robin - all bots get AI messages
  public sendAIMessage(message: string) {
    if (message?.trim()) { this.aiQueue.push(message); this.processAIQueue(); }
  }

  private async processManualQueue() {
    if (this.isSendingManual || !this.manualQueue.length) return;
    this.isSendingManual = true;
    while (this.manualQueue.length) {
      const msg = this.manualQueue.shift()!;
      try { await this.sendMessage(msg); this.messageCount++; }
      catch (e) { logger.error(`Bot[${this.botIndex}] manual error:`, e); }
      if (this.manualQueue.length) await new Promise(r => setTimeout(r, 350));
    }
    this.isSendingManual = false;
  }

  private async processAIQueue() {
    if (this.isSendingAI || !this.aiQueue.length) return;
    this.isSendingAI = true;
    const delay = parseInt(process.env.MESSAGE_INTERVAL || '5000');
    while (this.aiQueue.length) {
      const msg = this.aiQueue.shift()!;
      try { await this.sendMessage(msg); this.messageCount++; }
      catch (e) { logger.error(`Bot[${this.botIndex}] AI error:`, e); }
      if (this.aiQueue.length) await new Promise(r => setTimeout(r, delay));
    }
    this.isSendingAI = false;
  }

  private async setupVoiceCapture(channel: string) {
    try { await this.aiService.startVoiceCapture(channel); }
    catch (e) { logger.error('Voice capture setup error:', e); }
  }

  private async sendMessage(message: string) {
    if (!this.client || !message) return;
    const raw = process.env.TWITCH_CHANNEL!;
    const ch = raw.includes('twitch.tv/')
      ? raw.split('twitch.tv/')[1].split('/')[0].split('?')[0] : raw;
    await this.client.say(`#${ch}`, message);
  }

  public connect() {
    this.client?.connect().catch(e => {
      const msg = String(e);
      if (!msg.includes('Socket is not opened') && !msg.includes('Cannot disconnect'))
        logger.error(`Bot[${this.botIndex}] connect error:`, e);
    });
  }

  public disconnect() {
    this.manualQueue = []; this.aiQueue = [];
    try { this.client?.disconnect(); } catch (_) {}
    try { if (this.botIndex === 0) this.aiService.stopVoiceCapture(); } catch (_) {}
  }

  public isBotConnected() { return this.isConnected; }
  public getUsername() { return this.client?.getUsername() || ''; }
  public getBotIndex() { return this.botIndex; }
}
