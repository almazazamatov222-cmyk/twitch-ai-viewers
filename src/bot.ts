import * as tmi from 'tmi.js';
import { AIService } from './ai';

interface BotConfig {
  username: string;
  token: string;
}

interface BotInstance {
  client: tmi.Client;
  username: string;
  connected: boolean;
  reconnectAttempts: number;
  messagesSent: number;
  messageTimer?: NodeJS.Timeout;
}

export class BotManager {
  private bots: Map<string, BotInstance> = new Map();
  private ai: AIService;
  private channel: string;
  private messageInterval: number;
  private streamContext: string;
  private language: string;
  private emit: (event: string, data: any) => void;
  private globalInterval?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    settings: {
      messageInterval: number;
      language: string;
      streamContext: string;
      aiSettings: any;
    },
    emitFn: (event: string, data: any) => void
  ) {
    this.channel = channel.toLowerCase().replace('#', '');
    this.messageInterval = settings.messageInterval * 1000;
    this.streamContext = settings.streamContext;
    this.language = settings.language;
    this.emit = emitFn;
    this.ai = new AIService(groqKey, settings.aiSettings);

    configs.forEach(cfg => this.createBot(cfg));
  }

  private createBot(cfg: BotConfig): void {
    const token = cfg.token.startsWith('oauth:') ? cfg.token : `oauth:${cfg.token}`;

    const client = new tmi.Client({
      options: { debug: false, skipMembership: true },
      identity: {
        username: cfg.username,
        password: token,
      },
      channels: [`#${this.channel}`],
      connection: {
        reconnect: true,
        maxReconnectAttempts: 10,
        reconnectDecay: 1.5,
        reconnectInterval: 2000,
        secure: true,
      },
    });

    const instance: BotInstance = {
      client,
      username: cfg.username,
      connected: false,
      reconnectAttempts: 0,
      messagesSent: 0,
    };

    this.bots.set(cfg.username, instance);

    // Events
    client.on('connected', () => {
      instance.connected = true;
      instance.reconnectAttempts = 0;
      this.emit('bot:status', {
        username: cfg.username,
        state: 'connected',
        message: `Подключён к #${this.channel}`,
      });
    });

    client.on('disconnected', (reason) => {
      instance.connected = false;
      if (!this.stopped) {
        this.emit('bot:status', {
          username: cfg.username,
          state: 'reconnecting',
          message: `Переподключение... (${reason})`,
        });
      }
    });

    client.on('reconnect', () => {
      instance.reconnectAttempts++;
      this.emit('bot:status', {
        username: cfg.username,
        state: 'connecting',
        message: `Попытка ${instance.reconnectAttempts}...`,
      });
    });

    // Read chat for AI context
    client.on('message', (_channel, tags, message, self) => {
      if (!self && tags.username !== cfg.username) {
        this.ai.addChatContext(`${tags.username}: ${message}`);
      }
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });
  }

  async start(): Promise<void> {
    this.stopped = false;

    // Connect all bots (staggered to avoid rate limits)
    const connectPromises = Array.from(this.bots.values()).map((bot, idx) =>
      new Promise<void>(resolve => {
        setTimeout(async () => {
          try {
            await bot.client.connect();
          } catch (err: any) {
            this.emit('bot:status', {
              username: bot.username,
              state: 'error',
              message: err.message || 'Ошибка подключения',
            });
          }
          resolve();
        }, idx * 1500); // 1.5s between each bot
      })
    );

    await Promise.allSettled(connectPromises);

    // Start message scheduler - stagger bots so they don't all post at once
    this.startMessageScheduler();
  }

  private startMessageScheduler(): void {
    const bots = Array.from(this.bots.values());
    if (bots.length === 0) return;

    // Each bot sends on a staggered schedule
    bots.forEach((bot, idx) => {
      const offset = Math.floor((this.messageInterval / bots.length) * idx);
      
      bot.messageTimer = setTimeout(async () => {
        if (!this.stopped) {
          await this.sendBotMessage(bot);
          this.scheduleBotNext(bot);
        }
      }, offset + 3000); // Wait 3s after start for connections to establish
    });
  }

  private scheduleBotNext(bot: BotInstance): void {
    if (this.stopped) return;

    // Random jitter ±20% of interval to feel more human
    const jitter = (Math.random() * 0.4 - 0.2) * this.messageInterval;
    const delay = Math.max(8000, this.messageInterval + jitter);

    bot.messageTimer = setTimeout(async () => {
      if (!this.stopped) {
        await this.sendBotMessage(bot);
        this.scheduleBotNext(bot);
      }
    }, delay);
  }

  private async sendBotMessage(bot: BotInstance): Promise<void> {
    if (!bot.connected || this.stopped) return;

    try {
      const message = await this.ai.generateMessage(
        bot.username,
        this.streamContext,
        this.language
      );

      if (!message) return;

      await bot.client.say(`#${this.channel}`, message);
      bot.messagesSent++;

      this.emit('bot:message', {
        username: bot.username,
        message,
        count: bot.messagesSent,
      });
    } catch (err: any) {
      // Ignore "Not connected" errors during reconnection
      if (!err.message?.includes('Not connected')) {
        this.emit('bot:status', {
          username: bot.username,
          state: 'error',
          message: err.message,
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;

    // Clear all timers
    this.bots.forEach(bot => {
      if (bot.messageTimer) clearTimeout(bot.messageTimer);
    });

    // Disconnect all
    const disconnects = Array.from(this.bots.values()).map(bot =>
      bot.client.disconnect().catch(() => {})
    );
    await Promise.allSettled(disconnects);
    this.bots.clear();
  }

  getBotUsernames(): string[] {
    return Array.from(this.bots.keys());
  }
}
