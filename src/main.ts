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

// ── READ CONFIG FROM ENV ─────────────────────────────────────────────────────
function readConfig() {
  const channel = (process.env.TWITCH_CHANNEL || '').replace(/^#/, '').trim();
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  const interval = parseInt(process.env.MESSAGE_INTERVAL || '30');
  const context = (process.env.STREAM_CONTEXT || '').trim();

  // Read bots: BOT1_USERNAME + BOT1_OAUTH_TOKEN, BOT2_, BOT3_ ...
  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env[`BOT${i}_USERNAME`]?.trim();
    const t = process.env[`BOT${i}_OAUTH_TOKEN`]?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }

  return { channel, groqKey, language, interval, context, bots };
}

// ── TWITCH API ───────────────────────────────────────────────────────────────
let twitchToken: string | null = null;

async function fetchTwitchToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID;
  const cs = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !cs) return null;
  try {
    const r = await axios.post(
      `https://id.twitch.tv/oauth2/token?client_id=${cid}&client_secret=${cs}&grant_type=client_credentials`
    );
    return r.data.access_token as string;
  } catch { return null; }
}

async function pollStreamInfo(channel: string, emit: (e: string, d: unknown) => void): Promise<void> {
  const cid = process.env.TWITCH_CLIENT_ID;
  if (!cid || !channel) return;
  if (!twitchToken) twitchToken = await fetchTwitchToken();
  if (!twitchToken) return;

  try {
    const r = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
      headers: { 'Client-ID': cid, Authorization: `Bearer ${twitchToken}` },
    });
    const s = r.data.data?.[0];
    if (s) {
      emit('stream:viewers', { viewers: s.viewer_count });
      emit('stream:info', { live: true, game: s.game_name, viewers: s.viewer_count });
    } else {
      emit('stream:info', { live: false });
    }
  } catch (e: any) {
    if (e.response?.status === 401) twitchToken = null;
  }
}

// ── SOCKET.IO ────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let streamPoll: NodeJS.Timeout | null = null;

io.on('connection', socket => {
  console.log('[server] client connected', socket.id);

  // Send config to frontend
  socket.on('get:config', () => {
    const cfg = readConfig();
    socket.emit('config', { channel: cfg.channel });
  });

  // Manual message from operator
  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message) {
      await manager.sendManual(data.targets, data.message);
    }
  });

  socket.on('disconnect', () => {
    console.log('[server] client disconnected', socket.id);
  });
});

// ── AUTO-START BOTS FROM ENV ─────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readConfig();

  if (!cfg.channel) { console.warn('[server] TWITCH_CHANNEL not set'); return; }
  if (!cfg.groqKey) { console.warn('[server] GROQ_API_KEY not set'); return; }
  if (!cfg.bots.length) { console.warn('[server] No bots configured (BOT1_USERNAME / BOT1_OAUTH_TOKEN)'); return; }

  console.log(`[server] Auto-starting ${cfg.bots.length} bots for #${cfg.channel}`);

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

  // Notify frontend
  io.emit('bots:started', { bots: cfg.bots.map(b => b.username) });

  // Poll stream info every 30s
  await pollStreamInfo(cfg.channel, (e, d) => io.emit(e, d));
  streamPoll = setInterval(() => pollStreamInfo(cfg.channel, (e, d) => io.emit(e, d)), 30000);
}

// ── START ─────────────────────────────────────────────────────────────────────
http.listen(PORT, async () => {
  console.log(`\n🚀 TwitchBoost running at http://localhost:${PORT}\n`);
  // Wait a moment for socket connections then auto-start
  setTimeout(autoStart, 2000);
});

process.on('SIGTERM', async () => {
  if (streamPoll) clearInterval(streamPoll);
  if (manager) await manager.stop();
  process.exit(0);
});
