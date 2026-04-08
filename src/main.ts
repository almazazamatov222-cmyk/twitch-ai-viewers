import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import axios from 'axios';
import { BotManager } from './bot';

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

function readConfig() {
  const channel = (process.env.TWITCH_CHANNEL || '').replace(/^#/, '').trim();
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  const interval = parseInt(process.env.MESSAGE_INTERVAL || '30');
  const context = (process.env.STREAM_CONTEXT || '').trim();

  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) {
      bots.push({ username: u, token: t });
    }
  }

  return { channel, groqKey, language, interval, context, bots };
}

let twitchToken: string | null = null;

async function fetchTwitchToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID;
  const cs = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !cs) return null;
  try {
    const r = await axios.post(
      'https://id.twitch.tv/oauth2/token?client_id=' + cid + '&client_secret=' + cs + '&grant_type=client_credentials'
    );
    return r.data.access_token as string;
  } catch { return null; }
}

async function pollStreamInfo(channel: string, emitFn: (e: string, d: unknown) => void): Promise<void> {
  const cid = process.env.TWITCH_CLIENT_ID;
  if (!cid || !channel) return;
  if (!twitchToken) twitchToken = await fetchTwitchToken();
  if (!twitchToken) return;
  try {
    const r = await axios.get('https://api.twitch.tv/helix/streams?user_login=' + channel, {
      headers: { 'Client-ID': cid, Authorization: 'Bearer ' + twitchToken },
    });
    const s = r.data.data?.[0];
    if (s) {
      emitFn('stream:viewers', { viewers: s.viewer_count });
      emitFn('stream:info', { live: true, game: s.game_name, viewers: s.viewer_count });
    } else {
      emitFn('stream:info', { live: false });
    }
  } catch (e: any) {
    if (e.response?.status === 401) twitchToken = null;
  }
}

let manager: BotManager | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;

io.on('connection', socket => {
  console.log('[server] client connected ' + socket.id);

  const cfg = readConfig();
  socket.emit('config', { channel: cfg.channel });

  if (isStarted && startedBots.length > 0) {
    socket.emit('bots:started', { bots: startedBots });
    startedBots.forEach(u => {
      socket.emit('bot:status', { username: u, state: 'connected', message: 'Подключён' });
    });
  }

  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message) {
      await manager.sendManual(data.targets, data.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('[server] client disconnected ' + socket.id);
  });
});

async function autoStart(): Promise<void> {
  const cfg = readConfig();

  console.log('[server] channel=' + cfg.channel + ' bots=' + cfg.bots.length + ' groq=' + (cfg.groqKey ? 'yes' : 'NO'));
  cfg.bots.forEach((b, i) => console.log('  bot' + (i + 1) + ': ' + b.username));

  if (!cfg.channel) { console.warn('[server] TWITCH_CHANNEL not set'); return; }
  if (!cfg.groqKey)  { console.warn('[server] GROQ_API_KEY not set'); return; }
  if (!cfg.bots.length) {
    console.warn('[server] No bots found! Check BOT1_USERNAME and BOT1_OAUTH variables.');
    return;
  }

  if (manager) await manager.stop();

  manager = new BotManager(
    cfg.bots,
    cfg.channel,
    cfg.groqKey,
    {
      interval: cfg.interval,
      language: cfg.language,
      context: cfg.context,
      settings: { useEmoji: true, chatContext: true, uniquePersonas: true },
    },
    (event, data) => io.emit(event, data)
  );

  manager.start();
  startedBots = cfg.bots.map(b => b.username);
  isStarted = true;

  io.emit('bots:started', { bots: startedBots });
  console.log('[server] Started ' + startedBots.length + ' bots for #' + cfg.channel);

  await pollStreamInfo(cfg.channel, (e, d) => io.emit(e, d));
  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(() => pollStreamInfo(cfg.channel, (e, d) => io.emit(e, d)), 30000);
}

http.listen(PORT, () => {
  console.log('\n TwitchBoost running at http://localhost:' + PORT + '\n');
  setTimeout(autoStart, 1500);
});

process.on('SIGTERM', async () => {
  if (streamPoll) clearInterval(streamPoll);
  if (manager) await manager.stop();
  process.exit(0);
});
