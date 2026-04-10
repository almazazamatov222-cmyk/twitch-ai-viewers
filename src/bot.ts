import * as tmi from 'tmi.js';
import { AIService, PersonaConfig } from './ai';

interface BotConfig { username: string; token: string; }

interface BotInstance {
  client: tmi.Client;
  username: string;
  token: string;           // raw (no oauth: prefix)
  connected: boolean;
  connectTimer: NodeJS.Timeout | null;
  messages: number;
  index: number;
  lastMsgTime: number;
  // Viewer presence interval
  presenceInterval: ReturnType<typeof setInterval> | null;
  presenceActive: boolean;
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
  // Stagger which bots respond to each transcription
  private transcriptResponseIdx = 0;
  // How many bots respond per transcription (1 to all)
  private botsPerTranscript = 2;

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
    },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.language = opts.language;
    this.emit = emit;
    this.botsPerTranscript = opts.botsPerTranscript || 2;
    this.ai = new AIService(groqKey, opts.settings, opts.savedPersonas);

    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
    this.initReader();
  }

  // ── Called by main when Whisper transcribes audio ─────────────────────────
  async onTranscription(text: string): Promise<void> {
    if (this.stopped || !text.trim()) return;

    const allBots = Array.from(this.bots.values()).filter(b => b.connected);
    if (!allBots.length) return;

    // Pick N bots in round-robin rotation (not all at once — natural)
    const count = Math.min(this.botsPerTranscript, allBots.length);
    const responding: BotInstance[] = [];
    for (let i = 0; i < count; i++) {
      responding.push(allBots[(this.transcriptResponseIdx + i) % allBots.length]);
    }
    this.transcriptResponseIdx = (this.transcriptResponseIdx + count) % allBots.length;

    // Each responding bot sends with a random stagger (0–8s apart)
    for (let i = 0; i < responding.length; i++) {
      const bot = responding[i];
      const delay = i * (3000 + Math.random() * 5000);
      setTimeout(async () => {
        if (this.stopped || !bot.connected) return;
        const now = Date.now();
        if (now - bot.lastMsgTime < 5000) return;
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

  // ── Tag reply ─────────────────────────────────────────────────────────────
  private async sendTagReply(bot: BotInstance, original: string): Promise<void> {
    if (!bot.connected || this.stopped) return;
    if (Date.now() - bot.lastMsgTime < 3000) return;
    try {
      const msg = await this.ai.generateFromTranscription(
        bot.username, '', this.language, bot.index, original
      );
      if (!msg) return;
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
    } catch (e: any) {
      console.error('[bot] tag reply', bot.username, e.message);
    }
  }

  private initReader(): void {
    if (this.stopped) return;
    this.readerClient = new tmi.Client({
      options: { debug: false, skipMembership: true },
      channels: ['#' + this.channel],
      connection: { reconnect: true, secure: true },
    });

    this.readerClient.on('message', (
      _ch: string, tags: tmi.CommonUserstate, message: string, _self: boolean
    ) => {
      const senderLower = (tags.username || '').toLowerCase();
      const isBotAccount = this.bots.has(senderLower);

      this.emit('chat:message', {
        username: tags.username || '',
        displayName: tags['display-name'] || tags.username || '',
        message,
        color: tags.color || null,
        isBot: isBotAccount,
        id: tags.id || String(Date.now()),
      });

      if (!isBotAccount) {
        this.ai.addRealMessage(tags['display-name'] || tags.username || 'viewer', message);

        // Check @tags
        for (const [botKey, bot] of this.bots) {
          if (!bot.connected) continue;
          if (
            message.toLowerCase().includes('@' + botKey) ||
            message.toLowerCase().includes('@' + bot.username.toLowerCase())
          ) {
            setTimeout(() => {
              if (!this.stopped) this.sendTagReply(bot, message);
            }, 1500 + Math.random() * 2500);
          }
        }
      }
    });

    this.readerClient.connect().catch((e: Error) =>
      console.error('[reader]', e.message)
    );
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
      connected: false, connectTimer: null,
      messages: 0, index: idx, lastMsgTime: 0,
      presenceInterval: null, presenceActive: false,
    };
    this.bots.set(cfg.username.toLowerCase(), bot);

    client.on('connected', () => {
      if (this.stopped) { client.disconnect().catch(() => {}); return; }
      bot.connected = true;
      this.emit('bot:status', { username: cfg.username, state: 'connected', message: 'Подключён' });
      // Start presence simulation for this bot
      this.startBotPresence(bot);
    });
    client.on('disconnected', (reason: string) => {
      bot.connected = false;
      if (bot.presenceInterval) { clearInterval(bot.presenceInterval); bot.presenceInterval = null; }
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'reconnecting', message: reason });
    });
    client.on('reconnect', () => {
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' });
    });
    client.on('notice', (_ch: string, msgid: string, message: string) => {
      console.warn('[notice]', cfg.username, msgid, message);
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });
    bot.connectTimer = setTimeout(() => {
      if (!this.stopped)
        client.connect().catch((e: Error) => {
          this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
        });
    }, idx * 1500);
  }

  // ── PRESENCE: keep bot "watching" stream — accumulates channel points ──────
  private async startBotPresence(bot: BotInstance): Promise<void> {
    if (this.stopped || bot.presenceActive) return;
    bot.presenceActive = true;
    console.log('[presence] Starting for', bot.username);

    const poll = async () => {
      if (this.stopped || !bot.connected) return;
      try {
        const { default: axios } = await import('axios');

        // Step 1: Get stream playback token using BOT's own OAuth token
        // This authenticates the HLS session as the bot user → channel points accumulate
        const gql = await axios.post('https://gql.twitch.tv/gql', [{
          operationName: 'PlaybackAccessToken_Template',
          query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){
  streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature}
}`,
          variables: { login: this.channel, isLive: true, isVod: false, vodID: '', playerType: 'embed' },
        }], {
          headers: {
            // Use bot's own token so Twitch knows which user is watching
            'Authorization': 'OAuth ' + bot.token,
            'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });

        const token = gql.data?.[0]?.data?.streamPlaybackAccessToken;
        if (!token?.value) return; // stream offline

        const sig = token.signature;
        const tok = encodeURIComponent(token.value);
        const p = Math.floor(Math.random() * 999999);
        const m3u8 = `https://usher.twitchapps.com/api/channel/hls/${this.channel}.m3u8?sig=${sig}&token=${tok}&allow_source=true&fast_bread=true&p=${p}`;

        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
          'Origin': 'https://www.twitch.tv',
          'Referer': 'https://www.twitch.tv/',
          'Authorization': 'OAuth ' + bot.token,
        };

        // Step 2: Fetch master playlist
        const masterRes = await axios.get(m3u8, { headers, timeout: 10000 });

        // Step 3: Pick lowest quality playlist (less bandwidth)
        const lines: string[] = masterRes.data.split('\n');
        // Find 160p or lowest
        let playlistUrl = lines.find((l: string) => l.startsWith('http') && l.includes('160p'));
        if (!playlistUrl) playlistUrl = lines.find((l: string) => l.startsWith('http'));

        if (playlistUrl) {
          // Step 4: Fetch the media playlist — THIS is what Twitch counts
          const mediaRes = await axios.get(playlistUrl.trim(), { headers, timeout: 10000 });

          // Step 5: Fetch 1 actual segment — confirms active viewing session
          const segLines: string[] = mediaRes.data.split('\n');
          const segUrl = segLines.find((l: string) => l.startsWith('http'));
          if (segUrl) {
            await axios.get(segUrl.trim(), {
              headers,
              timeout: 15000,
              responseType: 'arraybuffer',
              maxContentLength: 500 * 1024, // max 500KB per segment
            });
          }

          if (!bot.presenceActive) return;
          console.log('[presence]', bot.username, '✓ watching');
          this.emit('presence:active', { username: bot.username });
        }
      } catch {
        // Stream offline or error — silent
      }
    };

    // Initial poll
    await poll();

    // Poll every 20s — Twitch requires segment requests to keep session alive
    // Channel points accumulate every 5 minutes of watch time
    bot.presenceInterval = setInterval(() => {
      if (this.stopped || !bot.connected) {
        if (bot.presenceInterval) clearInterval(bot.presenceInterval);
        bot.presenceInterval = null;
        return;
      }
      poll();
    }, 20000);
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      if (this.stopped) return;
      const bot = this.bots.get(u.toLowerCase()) || this.bots.get(u);
      if (!bot?.connected) continue;
      try {
        await bot.client.say('#' + this.channel, message);
        bot.messages++;
        bot.lastMsgTime = Date.now();
        this.emit('bot:message', { username: bot.username, message, count: bot.messages });
      } catch (e: any) {
        this.emit('bot:error', { username: bot.username, code: 'say_error', message: e.message });
      }
    }
  }

  setPersona(username: string, cfg: PersonaConfig): void { this.ai.setPersona(username, cfg); }
  getPersonas(): Record<string, PersonaConfig> { return this.ai.getPersonas(); }

  setBotsPerTranscript(n: number): void {
    this.botsPerTranscript = Math.max(1, Math.min(n, this.bots.size));
  }

  async stop(): Promise<void> {
    console.log('[manager] stopping...');
    this.stopped = true;
    for (const bot of this.bots.values()) {
      if (bot.presenceInterval) { clearInterval(bot.presenceInterval); bot.presenceInterval = null; }
      if (bot.connectTimer) { clearTimeout(bot.connectTimer); bot.connectTimer = null; }
      bot.connected = false;
      bot.presenceActive = false;
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
}
