import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { AIService } from './ai';
import { logger } from './logger';

export function startDashboardServer(aiService: AIService, bots: any[]) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  const botStates: Record<number, boolean> = {};
  const phraseGroups: Record<string, string[]> = {
    'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
    'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
    'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
  };

  bots.forEach((_, i) => { botStates[i] = true; });

  app.get('/api/status', (req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
    });
  });

  // Ручная отправка → manualMessage (без задержки)
  app.post('/api/send', (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    aiService.emit('manualMessage', message);
    res.json({ ok: true });
  });

  // Случайная из группы → manualMessage
  app.post('/api/phrase/random', (req, res) => {
    const { group } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases || phrases.length === 0) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    aiService.emit('manualMessage', phrase);
    res.json({ ok: true, phrase });
  });

  // Точная фраза → manualMessage
  app.post('/api/phrase/exact', (req, res) => {
    const { phrase } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    aiService.emit('manualMessage', phrase);
    res.json({ ok: true, phrase });
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

  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body;
    if (!group || !phrase) return res.status(400).json({ error: 'Missing data' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  // Socket события

  // Ручное сообщение отправлено → показываем в дашборде
  aiService.on('manualMessage', (message: string) => {
    io.emit('bot-sent', { message, manual: true, time: Date.now() });
  });

  // AI сообщение отправлено → показываем в дашборде
  aiService.on('message', (message: string) => {
    io.emit('bot-sent', { message, manual: false, time: Date.now() });
  });

  // Транскрипция
  aiService.on('transcription', (text: string) => {
    io.emit('transcription', { text, time: Date.now() });
  });

  // Входящие сообщения из Twitch
  aiService.on('incomingChat', (data: any) => {
    io.emit('incoming-chat', data);
  });

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => {
    logger.info(`Dashboard running at port ${PORT}`);
  });

  return { app, io };
}
