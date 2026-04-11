import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { BotManager } from './bot';
import { PersonaConfig } from './ai';
import { TranscriptionService } from './transcription';

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
app.use(express.json());
const FE_DIST = path.join(__dirname, '../frontend/dist');
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.static(FE_DIST));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => {
  res.sendFile(path.join(FE_DIST, 'index.html'));
});
const PORT = process.env.PORT || 3000;

// ── Persistent storage ──────────────────────────────────────────────────────
function getDataDir(): string {
  for (const d of ['/var/lib/twitch-boost', '/app/data', '/tmp/twitch-boost', path.join(__dirname, '../data')]) {
    try { 
      fs.mkdirSync(d, { recursive: true }); 
      // Test write
      fs.writeFileSync(path.join(d, '.test'), 'test');
      fs.unlinkSync(path.join(d, '.test'));
      console.log('[config] Using data dir:', d);
      return d; 
    } catch (e: any) { 
      console.log('[config] Cannot use:', d, e.message);
    }
  }
  return '/tmp';
}
const DATA_DIR = getDataDir();
const CONFIG_FILE = (channel: string) => path.join(DATA_DIR, `config-${channel}.json`);
console.log('[config] data dir:', DATA_DIR);

interface SavedConfig {
  personas: Record<string, PersonaConfig>;
  phraseGroups: Record<string, string[]>;
  botsPerTranscript?: number;
  botHistories?: Record<string, { role: string; content: string; time: number }[]>;
  transcriptHistory?: { heard: string; timestamp: number; responses: { username: string; message: string }[] }[];
  realChatHistory?: { username: string; message: string; time: number }[];
}

function loadSaved(channel: string): SavedConfig {
  const file = CONFIG_FILE(channel);
  try { if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log('[config] Loaded from:', file, 'personas:', Object.keys(data.personas || {}).length);
    return data;
  }}
  catch (e: any) { console.warn('[config] load error:', e.message); }
  return { personas: {}, phraseGroups: {} };
}
function saveToDisk(data: SavedConfig, channel: string): void {
  const file = CONFIG_FILE(channel);
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); console.log('[config] Saved to:', file); }
  catch (e: any) { console.error('[config] save error:', e.message); }
}

// ── Env config ──────────────────────────────────────────────────────────────
function extractChannel(raw: string): string {
  return raw.trim()
    .replace(/https?:\/\//g, '').replace(/www\.twitch\.tv\//g, '')
    .replace(/twitch\.tv\//g, '').replace(/^#/, '').replace(/\/$/, '')
    .trim().toLowerCase();
}
function readEnvConfig() {
  const channel = extractChannel(process.env.TWITCH_CHANNEL || '');
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  const context = (process.env.STREAM_CONTEXT || '').trim();
  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }
  return { channel, groqKey, language, context, bots };
}

// ── Helix ───────────────────────────────────────────────────────────────────
let appToken: string | null = null;
async function getAppToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim(), cs = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!cid || !cs) return null;
  try {
    const r = await axios.post('https://id.twitch.tv/oauth2/token?' + 
      new URLSearchParams({ client_id: cid, client_secret: cs, grant_type: 'client_credentials' }).toString());
    console.log('[helix] token response: ok, expires:', r.data.expires_in);
    return r.data.access_token as string;
  } catch (e: any) { 
    console.error('[helix] token error:', e.message);
    return null; 
  }
}
async function getStreamData(channel: string): Promise<{ live: boolean; viewers?: number; game?: string; userId?: string }> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  if (!cid || !channel) return { live: false };
  if (!appToken) {
    console.log('[helix] getting app token...');
    appToken = await getAppToken();
    console.log('[helix] got app token:', appToken ? 'OK' : 'FAILED');
  }
  if (!appToken) return { live: false };
  try {
    const [uRes, sRes] = await Promise.all([
      axios.get('https://api.twitch.tv/helix/users', { params: { login: channel }, headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken } }),
      axios.get('https://api.twitch.tv/helix/streams', { params: { user_login: channel }, headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken } }),
    ]);
    const userId = uRes.data.data?.[0]?.id as string | undefined;
    const s = sRes.data.data?.[0];
    if (s) {
      console.log('[helix] stream live, viewers:', s.viewer_count, 'game:', s.game_name);
      return { live: true, viewers: s.viewer_count, game: s.game_name, userId };
    }
    console.log('[helix] stream NOT live');
    return { live: false, userId };
  } catch (e: any) {
    if (e.response?.status === 401) appToken = null;
    return { live: false };
  }
}

// ── State ───────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let transcriber: TranscriptionService | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let historySaveInterval: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;
let currentChannel = '';
let saved: SavedConfig = { personas: {}, phraseGroups: {} };
let channelId: string | null = null;

function loadConfigForChannel(channel: string): SavedConfig {
  currentChannel = channel;
  saved = loadSaved(channel);
  console.log('[config] Loaded for channel:', channel, 'personas:', Object.keys(saved.personas).length, 'phrases:', Object.keys(saved.phraseGroups).length);
  return saved;
}

// ── REST ────────────────────────────────────────────────────────────────────
app.get('/api/transcript', (_req, res) => res.json(manager?.getTranscriptLog()?.slice(-100) || []));
app.get('/api/personas',   (_req, res) => res.json(saved.personas));
app.get('/api/phrases',    (_req, res) => res.json(saved.phraseGroups));
app.get('/api/presence',   (_req, res) => res.json(manager?.getPresenceStatus() || {}));
app.get('/api/points',     (_req, res) => res.json(manager?.getPointsBalances() || {}));
app.post('/api/claim-points', async (_req, res) => {
  if (!manager) return res.json({ error: 'Боты не запущены' });
  await manager.claimAllBonusChests();
  res.json({ ok: true });
});

// ── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[server] connected', socket.id);
  const cfg = readEnvConfig();
  socket.emit('config', { channel: cfg.channel, botsPerTranscript: saved.botsPerTranscript || 2 });
  socket.emit('personas:update', saved.personas);
  socket.emit('phrases:update', saved.phraseGroups);
  if (isStarted && startedBots.length > 0) {
    socket.emit('bots:started', { bots: startedBots });
    startedBots.forEach(u => socket.emit('bot:status', { username: u, state: 'connected', message: 'Подключён' }));
    if (manager) {
      socket.emit('presence:update', manager.getPresenceStatus());
      socket.emit('points:all', manager.getPointsBalances());
    }
  }

  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message) await manager.sendManual(data.targets, data.message);
  });
  socket.on('set:persona', (data: { username: string; role: string; sys: string }) => {
    const k = data.username.toLowerCase(), cfg2: PersonaConfig = { role: data.role, sys: data.sys };
    saved.personas[k] = cfg2; saveToDisk(saved, currentChannel);
    console.log('[persona] Saved for:', k);
    if (manager) manager.setPersona(data.username, cfg2);
    io.emit('personas:update', saved.personas);
    socket.emit('persona:saved', { username: data.username, ok: true });
  });
  socket.on('del:persona', (data: { username: string }) => {
    delete saved.personas[data.username.toLowerCase()]; saveToDisk(saved, currentChannel);
    io.emit('personas:update', saved.personas);
  });
  socket.on('set:phrases', (data: Record<string, string[]>) => {
    saved.phraseGroups = data; saveToDisk(saved, currentChannel); io.emit('phrases:update', saved.phraseGroups);
  });
  socket.on('set:bots_per_transcript', (data: { n: number }) => {
    const n = Math.max(1, parseInt(String(data.n)) || 2);
    saved.botsPerTranscript = n; saveToDisk(saved, currentChannel);
    if (manager) manager.setBotsPerTranscript(n);
    io.emit('config', { botsPerTranscript: n });
  });
  socket.on('get:personas', () => socket.emit('personas:update', saved.personas));
  socket.on('get:phrases',  () => socket.emit('phrases:update', saved.phraseGroups));
  socket.on('claim:points', async () => {
    if (manager) await manager.claimAllBonusChests();
    socket.emit('points:claimed_all', { ok: true });
  });
  socket.on('disconnect', () => console.log('[server] disconnected', socket.id));
});

// ── Auto-start ───────────────────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readEnvConfig();
  console.log('[server] channel="' + cfg.channel + '" bots=' + cfg.bots.length + ' groq=' + (cfg.groqKey ? 'OK' : 'MISSING'));
  if (!cfg.channel || !cfg.groqKey || !cfg.bots.length) { console.warn('[server] missing config'); return; }
  
  // Load config for this specific channel
  loadConfigForChannel(cfg.channel);

  if (manager) { await manager.stop(); manager = null; }
  if (transcriber) { transcriber.stop(); transcriber = null; }
  await new Promise(r => setTimeout(r, 1500));

  const info = await getStreamData(cfg.channel);
  channelId = (info as any).userId || null;
  console.log('[server] channelId=' + channelId + ' live=' + info.live);

  manager = new BotManager(
    cfg.bots, cfg.channel, cfg.groqKey,
    {
      language: cfg.language, context: cfg.context,
      settings: { useEmoji: true, chatContext: true },
      savedPersonas: saved.personas,
      botsPerTranscript: saved.botsPerTranscript || 2,
      channelId: channelId || undefined,
      clientId: process.env.TWITCH_CLIENT_ID?.trim(),
      savedHistory: saved.botHistories || {},
      savedTranscriptHistory: saved.transcriptHistory || [],
      savedRealChatHistory: saved.realChatHistory || [],
    },
    (event, data) => {
      io.emit(event, data);
      if (event === 'presence:active' && manager) io.emit('presence:update', manager.getPresenceStatus());
      if (event === 'points:balance') io.emit('points:all', manager?.getPointsBalances() || {});
      
      // Save history periodically
      if (event === 'transcript:entry' || event === 'bot:message') {
        const hist = manager?.getHistoryForSave();
        if (hist) {
          saved.botHistories = hist.histories;
          saved.transcriptHistory = hist.transcripts;
          saved.realChatHistory = hist.realChat;
          // Debounced save will happen automatically when config changes
        }
      }
    }
  );

  startedBots = manager.getUsernames();
  isStarted = true;
  io.emit('bots:started', { bots: startedBots });
  console.log('[server] started', startedBots.length, 'bots');
  
  // Send greeting after 3 seconds
  setTimeout(() => {
    if (manager) {
      const greetings = ['ку', 'привет', 'дарова', ' всем привет'];
      const randomBot = startedBots[Math.floor(Math.random() * startedBots.length)];
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      manager.sendManual([randomBot], greeting);
    }
  }, 3000);

  // Start transcription
  transcriber = new TranscriptionService(cfg.groqKey, cfg.channel);
  transcriber.start((result) => {
    console.log('[transcription] TEXT:', result.text.slice(0, 100));
    io.emit('transcription:new', { text: result.text, timestamp: result.timestamp });
    if (manager) manager.onTranscription(result.text);
  });

  io.emit('stream:info', { live: info.live, game: (info as any).game, viewers: (info as any).viewers });

  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(async () => {
    const si = await getStreamData(cfg.channel);
    if ((si as any).userId && !channelId) channelId = (si as any).userId;
    io.emit('stream:info', { live: si.live, game: (si as any).game, viewers: (si as any).viewers });
    if ((si as any).viewers != null) io.emit('stream:viewers', { viewers: (si as any).viewers });
  }, 30000);

  // Save history every 10 minutes - save EVERYTHING
  const historySaveInterval = setInterval(() => {
    if (manager) {
      const hist = manager.getHistoryForSave();
      saved.botHistories = hist.histories;
      saved.transcriptHistory = hist.transcripts;
      saved.realChatHistory = hist.realChat;
      console.log('[history] FULL SAVE, bots:', Object.keys(hist.histories).length, 'transcripts:', hist.transcripts.length, 'chat:', hist.realChat.length);
    }
    saveToDisk(saved, currentChannel);
    console.log('[history] Saved to disk');
  }, 600000);
}

http.listen(PORT, () => {
  console.log('\nTwitchBoost at http://localhost:' + PORT + '\n');
  setTimeout(autoStart, 1500);
});
process.on('SIGTERM', async () => {
  console.log('[server] Saving history before exit...');
  if (manager) {
    const hist = manager.getHistoryForSave();
    saved.botHistories = hist.histories;
    saved.transcriptHistory = hist.transcripts;
    saved.realChatHistory = hist.realChat;
    saveToDisk(saved, currentChannel);
  }
  if (streamPoll) clearInterval(streamPoll);
  if (transcriber) transcriber.stop();
  if (manager) await manager.stop();
  process.exit(0);
});
