import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { AIService } from './ai';
import { logger } from './logger';

// Railway Volume: mount /data в Settings → Volumes
// Fallback: /tmp (сессия), иначе дефолт
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
      const data = JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8'));
      logger.info(`Loaded phrases from ${PHRASES_FILE}`);
      return data;
    }
  } catch (e) {
    logger.warn('Could not load phrases, using defaults');
  }
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}

function savePhrases(groups: Record<string, string[]>): void {
  try {
    fs.writeFileSync(PHRASES_FILE, JSON.stringify(groups, null, 2));
    logger.info(`Phrases saved to ${PHRASES_FILE}`);
  } catch (e) {
    logger.warn('Could not save phrases:', e);
  }
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

  // Dedup incoming chat messages (all bots forward, we filter by ID)
  const seenMessages = new Set<string>();
  const SEEN_TTL = 5000; // 5 seconds

  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
      storageInfo: DATA_DIR === '/data' ? 'Railway Volume ✓' : 'Временное хранилище (добавь Volume в Railway для постоянного)'
    });
  });

  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const idx = parseInt(String(botIndex)) || 0;
    logger.info(`Dashboard send: bot[${idx}] "${message}"`);
    aiService.emit(`manualMessage_${idx}`, message);
    io.emit('bot-sent', {
      message, botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true, time: Date.now()
    });
    res.json({ ok: true });
  });

  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', {
      message: phrase, botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true, time: Date.now()
    });
    res.json({ ok: true, phrase });
  });

  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', {
      message: phrase, botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true, time: Date.now()
    });
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

  // Deduplicated incoming chat forwarding
  aiService.on('incomingChat', (data: any) => {
    const msgId = data.id || `${data.username}-${data.message}`;
    if (seenMessages.has(msgId)) return;
    seenMessages.add(msgId);
    setTimeout(() => seenMessages.delete(msgId), SEEN_TTL);
    io.emit('incoming-chat', data);
  });

  // AI generated message
  aiService.on('message', (message: string) => {
    const botName = bots[0]?.getUsername?.() || 'Бот';
    io.emit('bot-sent', { message, botIndex: 0, botName, manual: false, time: Date.now() });
  });

  aiService.on('transcription', (text: string) => {
    io.emit('transcription', { text, time: Date.now() });
  });

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => {
    logger.info(`Dashboard at port ${PORT} | Phrases storage: ${PHRASES_FILE}`);
  });
  return { app, io };
}
