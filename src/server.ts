import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { AIService } from './ai';
import { ViewerSimulator } from './viewer';
import { logger } from './logger';

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const PHRASES_FILE = path.join(DATA_DIR, 'phrases.json');

const DEFAULT_PHRASES: Record<string, string[]> = {
  'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
  'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
  'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
};

function loadPhrases(): Record<string, string[]> {
  try {
    if (fs.existsSync(PHRASES_FILE)) {
      return JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8'));
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}

function savePhrases(g: Record<string, string[]>) {
  try { fs.writeFileSync(PHRASES_FILE, JSON.stringify(g, null, 2)); } catch (_) {}
}

// Get OAuth token for a bot by index (1-based env var)
function getBotOauth(botIndex: number): string {
  return (process.env[`BOT${botIndex + 1}_OAUTH_TOKEN`] || process.env[`BOT${botIndex + 1}_OAUTH`] || '').replace('oauth:', '');
}

// Follow channel via Twitch GQL mutation (works as of 2025)
async function followViaGQL(oauth: string, broadcasterId: string): Promise<void> {
  await axios.post('https://gql.twitch.tv/gql', [
    {
      operationName: 'FollowButton_FollowUser',
      variables: { input: { targetID: broadcasterId, disableNotifications: false } },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b715d7e4a23'
        }
      }
    }
  ], {
    headers: {
      'Authorization': `OAuth ${oauth}`,
      'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Content-Type': 'application/json',
    }
  });
}

// Get Twitch user ID from channel name
async function getChannelId(channelName: string, oauth: string): Promise<string> {
  const resp = await axios.post('https://gql.twitch.tv/gql', {
    query: `{ user(login: "${channelName}") { id } }`
  }, {
    headers: {
      'Authorization': `OAuth ${oauth}`,
      'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Content-Type': 'application/json',
    }
  });
  const id = resp.data?.data?.user?.id;
  if (!id) throw new Error('Channel not found');
  return id;
}

export function startDashboardServer(aiService: AIService, bots: any[]) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  const botStates: Record<number, boolean> = {};
  bots.forEach((_, i) => { botStates[i] = true; });
  const phraseGroups = loadPhrases();
  logger.info(`Phrases loaded from ${PHRASES_FILE}`);

  // Viewer simulators per bot
  const viewers: Record<number, ViewerSimulator> = {};

  // Dedup incoming chat
  const seenMsgs = new Set<string>();

  // Channel name helper
  function getChannelName(): string {
    const ch = process.env.TWITCH_CHANNEL || '';
    return ch.includes('twitch.tv/') ? ch.split('twitch.tv/')[1].split('/')[0].split('?')[0] : ch;
  }

  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        watching: !!viewers[i],
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
      storageInfo: DATA_DIR === '/data' ? 'Railway Volume ✓' : 'Временное (/tmp)'
    });
  });

  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, message);
    io.emit('bot-sent', { message, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx+1}`, manual: true, time: Date.now() });
    res.json({ ok: true });
  });

  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', { message: phrase, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx+1}`, manual: true, time: Date.now() });
    res.json({ ok: true, phrase });
  });

  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', { message: phrase, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx+1}`, manual: true, time: Date.now() });
    res.json({ ok: true });
  });

  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body;
    if (!group || !phrase) return res.status(400).json({ error: 'Missing data' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase);
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/phrases/delete', (req, res) => {
    const { group, phrase } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    phraseGroups[group] = phraseGroups[group].filter(p => p !== phrase);
    if (!phraseGroups[group].length) delete phraseGroups[group];
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/phrases/rename-group', (req, res) => {
    const { oldName, newName } = req.body;
    if (!phraseGroups[oldName] || !newName) return res.status(400).json({ error: 'Invalid' });
    phraseGroups[newName] = phraseGroups[oldName];
    delete phraseGroups[oldName];
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/phrases/delete-group', (req, res) => {
    const { group } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    delete phraseGroups[group];
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body;
    const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    botStates[botIndex] = !botStates[botIndex];
    botStates[botIndex] ? bot.connect?.() : bot.disconnect?.();
    io.emit('bot-state', { botIndex, enabled: botStates[botIndex] });
    res.json({ ok: true, enabled: botStates[botIndex] });
  });

  // FOLLOW via GQL
  app.post('/api/follow', async (req, res) => {
    const { botIndex = 0 } = req.body;
    const idx = parseInt(String(botIndex));
    const oauth = getBotOauth(idx);
    const botName = bots[idx]?.getUsername?.() || `Bot${idx+1}`;

    if (!oauth) return res.status(400).json({ error: 'No OAuth token for this bot' });

    try {
      const channelName = getChannelName();
      const broadcasterId = await getChannelId(channelName, oauth);
      await followViaGQL(oauth, broadcasterId);
      logger.info(`Bot ${botName} followed ${channelName}`);
      res.json({ ok: true, botName });
    } catch (e: any) {
      const msg = e?.response?.data?.[0]?.errors?.[0]?.message || e?.message || 'Failed';
      logger.error(`Follow error for ${botName}:`, msg);
      res.status(500).json({ error: msg });
    }
  });

  // FOLLOW ALL
  app.post('/api/follow-all', async (req, res) => {
    const results: any[] = [];
    const channelName = getChannelName();
    let broadcasterId = '';

    // Get channel ID once
    try {
      const oauth = getBotOauth(0);
      broadcasterId = await getChannelId(channelName, oauth);
    } catch (e) {
      return res.status(500).json({ error: 'Could not get channel ID' });
    }

    for (let i = 0; i < bots.length; i++) {
      const oauth = getBotOauth(i);
      const botName = bots[i]?.getUsername?.() || `Bot${i+1}`;
      if (!oauth) { results.push({ botName, ok: false, error: 'No token' }); continue; }
      try {
        await followViaGQL(oauth, broadcasterId);
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 500)); // small delay between follows
      } catch (e: any) {
        results.push({ botName, ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // WATCH - start viewer simulation for a bot
  app.post('/api/watch', async (req, res) => {
    const { botIndex = 0 } = req.body;
    const idx = parseInt(String(botIndex));
    const oauth = getBotOauth(idx);
    const botName = bots[idx]?.getUsername?.() || `Bot${idx+1}`;

    if (viewers[idx]) {
      viewers[idx].stop();
      delete viewers[idx];
      io.emit('bot-state', {});
      return res.json({ ok: true, watching: false, botName });
    }

    try {
      const sim = new ViewerSimulator(getChannelName(), oauth);
      await sim.start();
      viewers[idx] = sim;
      io.emit('bot-state', {});
      res.json({ ok: true, watching: true, botName });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Could not start viewer' });
    }
  });

  // WATCH ALL
  app.post('/api/watch-all', async (_req, res) => {
    const results: any[] = [];
    for (let i = 0; i < bots.length; i++) {
      if (viewers[i]) continue; // already watching
      const oauth = getBotOauth(i);
      const botName = bots[i]?.getUsername?.() || `Bot${i+1}`;
      try {
        const sim = new ViewerSimulator(getChannelName(), oauth);
        await sim.start();
        viewers[i] = sim;
        results.push({ botName, ok: true });
      } catch (e: any) {
        results.push({ botName, ok: false, error: e?.message });
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    io.emit('bot-state', {});
    res.json({ results });
  });

  // Events
  aiService.on('incomingChat', (data: any) => {
    const id = data.id || `${data.username}:${data.message}`;
    if (seenMsgs.has(id)) return;
    seenMsgs.add(id);
    setTimeout(() => seenMsgs.delete(id), 5000);
    io.emit('incoming-chat', data);
  });

  aiService.on('message', (message: string) => {
    io.emit('bot-sent', { message, botIndex: 0, botName: bots[0]?.getUsername?.() || 'Бот', manual: false, time: Date.now() });
  });

  aiService.on('transcription', (text: string) => io.emit('transcription', { text, time: Date.now() }));

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => logger.info(`Dashboard at port ${PORT}`));
  return { app, io };
}
