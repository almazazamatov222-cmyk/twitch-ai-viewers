import * as tmi from 'tmi.js';
import { AIService, PersonaConfig } from './ai';
import { ChannelPointsService } from './points';

interface BotConfig { username: string; token: string; }

interface BotInstance {
  client: tmi.Client;
  username: string;
  token: string;
  connected: boolean;
  connectTimer: NodeJS.Timeout | null;
  messages: number;
  index: number;
  lastMsgTime: number;
  presenceInterval: ReturnType<typeof setInterval> | null;
  presenceActive: boolean;
  pointsBalance: number | null;
}

type EmitFn = (event: string, data: unknown) => void;

export class BotManager {
  private bots = new Map<string, BotInstance>();
  private ai: AIService;
  private channel: string;
  private language: string;
  private emit: EmitFn;
  private stopped = false;
  private readerClient: tmi.Client | null = null;
  private transcriptResponseIdx = 0;
  private botsPerTranscript = 2;
  private pointsService: ChannelPointsService | null = null;

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: {
      language: string;
      context: string;
      settings: Record<string, boolean>;
      savedPersonas?: Record<string, PersonaConfig>;
      botsPerTranscript?: number;
      channelId?: string;
      clientId?: string;
      savedHistory?: Record<string, { role: string; content: string; time: number }[]>;
      savedTranscriptHistory?: { heard: string; timestamp: number; responses: { username: string; message: string }[] }[];
      savedRealChatHistory?: { username: string; message: string; time: number }[];
    },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.language = opts.language;
    this.emit = emit;
    this.botsPerTranscript = opts.botsPerTranscript || 2;
    this.ai = new AIService(groqKey, opts.settings, opts.savedPersonas, opts.savedHistory, opts.savedTranscriptHistory, opts.savedRealChatHistory);

    // Init points service if we have channel ID
    if (opts.channelId && opts.clientId) {
      this.pointsService = new ChannelPointsService(
        this.channel, opts.channelId, opts.clientId, emit
      );
    }

    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
    this.initReader();
  }

  async onTranscription(text: string): Promise<void> {
    if (this.stopped || !text.trim()) return;
    // Skip some transcriptions randomly to make it more natural
    if (Math.random() < 0.2) {
      console.log('[bot] Skipping transcription (random)');
      return;
    }
    const allBots = Array.from(this.bots.values()).filter(b => b.connected);
    if (!allBots.length) return;

    const maxCount = this.botsPerTranscript === 99 ? allBots.length : this.botsPerTranscript;
    const count = Math.max(1, Math.min(maxCount, allBots.length) - (this.botsPerTranscript === 99 ? 0 : (Math.random() < 0.3 ? 1 : 0)));
    const responding: BotInstance[] = [];
    for (let i = 0; i < count; i++) {
      responding.push(allBots[(this.transcriptResponseIdx + i) % allBots.length]);
    }
    this.transcriptResponseIdx = (this.transcriptResponseIdx + count) % allBots.length;

    for (let i = 0; i < responding.length; i++) {
      const bot = responding[i];
      const delay = i * (5000 + Math.random() * 5000) + Math.random() * 5000;
      setTimeout(async () => {
        if (this.stopped || !bot.connected) return;
if (Date.now() - bot.lastMsgTime < 5000) return;
        try {
          const msg = await this.ai.generateFromTranscription(
            bot.username, text, this.language, bot.index
          );
          if (!msg || this.stopped) return;
          console.log('[bot]', bot.username, '→', '"' + msg + '"');
          await bot.client.say('#' + this.channel, msg);
          bot.messages++;
          bot.lastMsgTime = Date.now();
          this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
          const log = this.ai.transcriptLog;
          if (log.length) this.emit('transcript:entry', log[log.length - 1]);
        } catch (e: any) {
          const m = String(e?.message || e);
          if (!m.includes('Not connected') && !m.includes('No response'))
            this.emit('bot:error', { username: bot.username, code: 'say_error', message: m });
        }
      }, delay);
    }
  }

  private async sendTagReply(bot: BotInstance, original: string): Promise<void> {
    if (!bot.connected || this.stopped) return;
    if (Date.now() - bot.lastMsgTime < 3000) return;
    try {
      const msg = await this.ai.generateFromTranscription(bot.username, '', this.language, bot.index, original);
      if (!msg) return;
      await bot.client.say('#' + this.channel, msg);
      bot.messages++; bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
    } catch (e: any) { console.error('[bot] tag reply', bot.username, e.message); }
  }

  private initReader(): void {
    if (this.stopped) return;
    this.readerClient = new tmi.Client({
      options: { debug: false, skipMembership: true },
      channels: ['#' + this.channel],
      connection: { reconnect: true, secure: true },
    });
    this.readerClient.on('message', (_ch, tags, message, _self) => {
      const senderLower = (tags.username || '').toLowerCase();
      const isBotAccount = this.bots.has(senderLower);
      this.emit('chat:message', {
        username: tags.username || '', displayName: tags['display-name'] || tags.username || '',
        message, color: tags.color || null, isBot: isBotAccount, id: tags.id || String(Date.now()),
      });
      if (!isBotAccount) {
        // chat reading disabled - only transcription
        for (const [botKey, bot] of this.bots) {
          if (!bot.connected) continue;
          if (message.toLowerCase().includes('@' + botKey) || message.toLowerCase().includes('@' + bot.username.toLowerCase())) {
            setTimeout(() => { if (!this.stopped) this.sendTagReply(bot, message); }, 500 + Math.random() * 1000);
          }
        }
      }
    });
    this.readerClient.connect().catch((e: Error) => console.error('[reader]', e.message));
  }

  private initBot(cfg: BotConfig, idx: number): void {
    const token = cfg.token.replace(/^oauth:/i, '');
    const client = new tmi.Client({
      options: { debug: false, skipMembership: true },
      identity: { username: cfg.username, password: 'oauth:' + token },
      channels: ['#' + this.channel],
      connection: { reconnect: true, maxReconnectAttempts: 20, reconnectInterval: 3000, secure: true },
    });
    const bot: BotInstance = {
      client, username: cfg.username, token,
      connected: false, connectTimer: null, messages: 0, index: idx,
      lastMsgTime: 0, presenceInterval: null, presenceActive: false, pointsBalance: null,
    };
    this.bots.set(cfg.username.toLowerCase(), bot);

    client.on('connected', () => {
      if (this.stopped) { client.disconnect().catch(() => {}); return; }
      bot.connected = true;
      this.emit('bot:status', { username: cfg.username, state: 'connected', message: 'Подключён' });
      this.startPresence(bot);
      // Connect to PubSub for channel points
      if (this.pointsService) {
        this.pointsService.connectBot(cfg.username, token).catch(() => {});
      }
      // Fetch initial points balance
      this.fetchBalance(bot);
    });
    client.on('disconnected', (reason) => {
      bot.connected = false;
      if (bot.presenceInterval) { clearInterval(bot.presenceInterval); bot.presenceInterval = null; bot.presenceActive = false; }
      if (!this.stopped) this.emit('bot:status', { username: cfg.username, state: 'reconnecting', message: reason });
    });
    client.on('reconnect', () => {
      if (!this.stopped) this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' });
    });
    client.on('notice', (_ch, msgid, message) => {
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });
    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });
    bot.connectTimer = setTimeout(() => {
      if (!this.stopped) client.connect().catch((e: Error) => {
        this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
      });
    }, idx * 1500);
  }

  private async fetchBalance(bot: BotInstance): Promise<void> {
    if (!this.pointsService) return;
    const balance = await this.pointsService.getBalance(bot.username, bot.token, '');
    if (balance != null) {
      bot.pointsBalance = balance;
      this.emit('points:balance', { username: bot.username, balance });
    }
  }

  // Manually trigger bonus chest claim for all bots
  async claimAllBonusChests(): Promise<void> {
    if (!this.pointsService) return;
    for (const bot of this.bots.values()) {
      if (bot.connected) {
        await this.pointsService.claimBonusChest(bot.username, bot.token, bot.username);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  private async startPresence(bot: BotInstance): Promise<void> {
    if (this.stopped || bot.presenceActive) return;
    bot.presenceActive = true;
    console.log('[presence] Starting for', bot.username);

    const poll = async () => {
      if (this.stopped || !bot.connected) return;
      try {
        const { default: axios } = await import('axios');
        const gql = await axios.post('https://gql.twitch.tv/gql', [{
          operationName: 'PlaybackAccessToken_Template',
          query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature}}`,
          variables: { login: this.channel, isLive: true, isVod: false, vodID: '', playerType: 'embed' },
        }], {
          headers: {
            'Authorization': 'OAuth ' + bot.token,
            'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });
        const token = gql.data?.[0]?.data?.streamPlaybackAccessToken;
        if (!token?.value) return;
        const sig = token.signature, tok = encodeURIComponent(token.value), p = Math.floor(Math.random() * 999999);
        const m3u8 = `https://usher.twitchapps.com/api/channel/hls/${this.channel}.m3u8?sig=${sig}&token=${tok}&allow_source=true&fast_bread=true&p=${p}`;
        const h = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
          'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/',
          'Authorization': 'OAuth ' + bot.token,
        };
        const masterRes = await axios.get(m3u8, { headers: h, timeout: 10000 });
        const lines: string[] = masterRes.data.split('\n');
        const playlistUrl = lines.find((l: string) => l.startsWith('http') && l.includes('160p'))
          || lines.find((l: string) => l.startsWith('http'));
        if (playlistUrl) {
          const mediaRes = await axios.get(playlistUrl.trim(), { headers: h, timeout: 10000 });
          const segUrl = mediaRes.data.split('\n').find((l: string) => l.startsWith('http'));
          if (segUrl) {
            await axios.get(segUrl.trim(), { headers: h, timeout: 15000, responseType: 'arraybuffer', maxContentLength: 300 * 1024 });
            console.log('[presence]', bot.username, '✓');
            this.emit('presence:active', { username: bot.username });
          }
        }
      } catch { /* stream offline or error — silent */ }
    };

    await poll();
    bot.presenceInterval = setInterval(() => {
      if (this.stopped || !bot.connected) { if (bot.presenceInterval) clearInterval(bot.presenceInterval); return; }
      poll();
    }, 15000);
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      if (this.stopped) return;
      const bot = this.bots.get(u.toLowerCase()) || this.bots.get(u);
      if (!bot?.connected) continue;
      try {
        await bot.client.say('#' + this.channel, message);
        bot.messages++; bot.lastMsgTime = Date.now();
        this.emit('bot:message', { username: bot.username, message, count: bot.messages });
      } catch (e: any) { this.emit('bot:error', { username: bot.username, code: 'say_error', message: e.message }); }
    }
  }

  setPersona(username: string, cfg: PersonaConfig): void { this.ai.setPersona(username, cfg); }
  getPersonas(): Record<string, PersonaConfig> { return this.ai.getPersonas(); }
  setBotsPerTranscript(n: number): void { this.botsPerTranscript = n === 99 ? 99 : Math.max(1, n); }

  async stop(): Promise<void> {
    console.log('[manager] stopping...');
    this.stopped = true;
    if (this.pointsService) { this.pointsService.stop(); this.pointsService = null; }
    for (const bot of this.bots.values()) {
      if (bot.presenceInterval) { clearInterval(bot.presenceInterval); bot.presenceInterval = null; }
      if (bot.connectTimer) { clearTimeout(bot.connectTimer); bot.connectTimer = null; }
      bot.connected = false;
    }
    if (this.readerClient) { this.readerClient.disconnect().catch(() => {}); this.readerClient = null; }
    await Promise.allSettled(Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {})));
    this.bots.clear();
    console.log('[manager] stopped');
  }

  getUsernames(): string[] { return Array.from(this.bots.values()).map(b => b.username); }
  getTranscriptLog() { return this.ai.transcriptLog; }
  getPresenceStatus(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [k, b] of this.bots) out[k] = b.presenceActive && b.connected;
    return out;
  }
  getPointsBalances(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const [k, b] of this.bots) out[k] = b.pointsBalance;
    return out;
  }
  getHistoryForSave(): { histories: Record<string, any[]>; transcripts: any[]; realChat: any[] } {
    return this.ai.getHistoryForSave();
  }
}
