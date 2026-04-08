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
  timer?: NodeJS.Timeout;
  messages: number;
}

type EmitFn = (event: string, data: unknown) => void;

export class BotManager {
  private bots = new Map<string, BotInstance>();
  private ai: AIService;
  private channel: string;
  private intervalMs: number;
  private context: string;
  private language: string;
  private emit: EmitFn;
  private stopped = false;

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: { interval: number; language: string; context: string; settings: Record<string, boolean> },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.intervalMs = Math.max(10, opts.interval) * 1000;
    this.context = opts.context;
    this.language = opts.language;
    this.emit = emit;
    this.ai = new AIService(groqKey, opts.settings);

    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
  }

  private initBot(cfg: BotConfig, idx: number): void {
    const token = cfg.token.startsWith('oauth:') ? cfg.token : 'oauth:' + cfg.token;

    const client = new tmi.Client({
      options: { debug: false, skipMembership: true },
      identity: { username: cfg.username, password: token },
      channels: ['#' + this.channel],
      connection: { reconnect: true, maxReconnectAttempts: 20, reconnectInterval: 3000, secure: true },
    });

    const bot: BotInstance = { client, username: cfg.username, connected: false, messages: 0 };
    this.bots.set(cfg.username, bot);

    client.on('connected', () => {
      bot.connected = true;
      this.emit('bot:status', { username: cfg.username, state: 'connected', message: 'Подключён' });
    });
    client.on('disconnected', (reason: string) => {
      bot.connected = false;
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'reconnecting', message: reason });
    });
    client.on('reconnect', () => {
      this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' });
    });
    client.on('message', (_ch: string, tags: tmi.CommonUserstate, message: string, self: boolean) => {
      if (!self) this.ai.addChatContext((tags.username || '') + ': ' + message);
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });

    // Stagger connection
    setTimeout(() => {
      if (!this.stopped)
        client.connect().catch((e: Error) =>
          this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message })
        );
    }, idx * 1500);
  }

  start(): void {
    this.stopped = false;
    const bots = Array.from(this.bots.values());

    // Stagger first messages then schedule individually
    bots.forEach((bot, idx) => {
      const delay = 5000 + (this.intervalMs / bots.length) * idx;
      bot.timer = setTimeout(() => this.scheduleBot(bot), delay);
    });
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;
    this.sendMsg(bot).then(() => {
      if (!this.stopped) {
        const jitter = (Math.random() * 0.4 - 0.2) * this.intervalMs;
        bot.timer = setTimeout(() => this.scheduleBot(bot), Math.max(8000, this.intervalMs + jitter));
      }
    });
  }

  private async sendMsg(bot: BotInstance): Promise<void> {
    if (!bot.connected || this.stopped) return;
    try {
      const msg = await this.ai.generateMessage(bot.username, this.context, this.language);
      if (!msg) return;
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
    } catch (e: any) {
      if (!e.message?.includes('Not connected'))
        this.emit('bot:status', { username: bot.username, state: 'error', message: e.message });
    }
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      const bot = this.bots.get(u);
      if (!bot?.connected) continue;
      try {
        await bot.client.say('#' + this.channel, message);
        bot.messages++;
        this.emit('bot:message', { username: u, message, count: bot.messages });
      } catch (e: any) {
        this.emit('bot:status', { username: u, state: 'error', message: e.message });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bots.forEach(bot => { if (bot.timer) clearTimeout(bot.timer); });
    await Promise.allSettled(Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {})));
    this.bots.clear();
  }

  getUsernames(): string[] {
    return Array.from(this.bots.keys());
  }
}
