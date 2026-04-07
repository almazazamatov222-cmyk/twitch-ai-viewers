import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import axios from 'axios';
import { BotManager } from './bot';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;

let botManager: BotManager | null = null;
let streamInfoInterval: NodeJS.Timeout | null = null;
let twitchAccessToken: string | null = null;

// ─── TWITCH HELIX API ──────────────────────────────────────────────────────

async function getTwitchToken(): Promise<string | null> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await axios.post(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
    );
    return res.data.access_token;
  } catch {
    return null;
  }
}

async function getStreamInfo(channel: string, socket: any): Promise<void> {
  if (!twitchAccessToken) {
    twitchAccessToken = await getTwitchToken();
    if (!twitchAccessToken) return;
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return;

  try {
    const res = await axios.get(
      `https://api.twitch.tv/helix/streams?user_login=${channel}`,
      {
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${twitchAccessToken}`,
        },
      }
    );

    const stream = res.data.data?.[0];
    if (stream) {
      const thumbnail = stream.thumbnail_url
        .replace('{width}', '320')
        .replace('{height}', '180');

      socket.emit('stream:info', {
        live: true,
        title: stream.title,
        meta: `${stream.game_name} · ${stream.viewer_count.toLocaleString()} зрителей`,
        thumbnail,
      });

      socket.emit('stream:viewers', { viewers: stream.viewer_count });
    } else {
      socket.emit('stream:info', {
        live: false,
        title: channel,
        meta: 'Стрим не идёт',
      });
    }
  } catch (err: any) {
    if (err.response?.status === 401) {
      // Token expired, refresh
      twitchAccessToken = await getTwitchToken();
    }
  }
}

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Server] Client connected: ${socket.id}`);

  socket.on('bots:start', async (data) => {
    try {
      if (botManager) {
        await botManager.stop();
        botManager = null;
      }

      const { channel, groqKey, interval, lang, context, bots, settings } = data;

      if (!channel || !groqKey || !bots?.length) {
        socket.emit('error', { message: 'Не все поля заполнены' });
        return;
      }

      // Create bot manager
      botManager = new BotManager(
        bots,
        channel,
        groqKey,
        {
          messageInterval: Math.max(10, interval || 30),
          language: lang || 'ru',
          streamContext: context || '',
          aiSettings: settings || {},
        },
        (event, eventData) => {
          socket.emit(event, eventData);
        }
      );

      await botManager.start();

      socket.emit('bots:started', { bots: bots.map((b: any) => b.username) });

      // Start polling stream info
      if (streamInfoInterval) clearInterval(streamInfoInterval);
      await getStreamInfo(channel, socket);
      streamInfoInterval = setInterval(() => getStreamInfo(channel, socket), 30000);

    } catch (err: any) {
      console.error('[Server] Error starting bots:', err);
      socket.emit('error', { message: err.message || 'Ошибка запуска' });
    }
  });

  socket.on('bots:stop', async () => {
    try {
      if (streamInfoInterval) {
        clearInterval(streamInfoInterval);
        streamInfoInterval = null;
      }
      if (botManager) {
        await botManager.stop();
        botManager = null;
      }
      socket.emit('bots:stopped');
    } catch (err: any) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Server] Client disconnected: ${socket.id}`);
  });
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

httpServer.listen(PORT, () => {
  console.log(`\n🚀 TwitchAI Boost running at http://localhost:${PORT}\n`);
});

process.on('SIGTERM', async () => {
  if (botManager) await botManager.stop();
  process.exit(0);
});
