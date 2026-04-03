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
  try { if (fs.existsSync(PHRASES_FILE)) return JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8')); } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}
function savePhrases(g: Record<string, string[]>) {
  try { fs.writeFileSync(PHRASES_FILE, JSON.stringify(g, null, 2)); } catch (_) {}
}

function getChannelName(): string {
  const ch = process.env.TWITCH_CHANNEL || '';
  return ch.includes('twitch.tv/') ? ch.split('twitch.tv/')[1].split('/')[0].split('?')[0] : ch;
}

// Get user token for follow/viewer: BOT1_USER_TOKEN, BOT2_USER_TOKEN, ...

const GQL_ANON_HEADERS = {
  'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin': 'https://www.twitch.tv',
  'Referer': 'https://www.twitch.tv/',
};

async function getChannelId(channelName: string): Promise<string> {
  const resp = await axios.post('https://gql.twitch.tv/gql',
    { query: `{ user(login: "${channelName}") { id } }` },
    { headers: GQL_ANON_HEADERS, timeout: 10000 }
  );
  const id = resp.data?.data?.user?.id;
  if (!id) throw new Error('Channel not found');
  return id;
}

async function followChannel(userToken: string, broadcasterId: string): Promise<void> {
  const meResp = await axios.get('https://api.twitch.tv/helix/users', {
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${userToken}` }
  });
  const userId = meResp.data.data[0]?.id;
  if (!userId) throw new Error('Could not get user ID from token');

  // Try Helix follow endpoint
  try {
    await axios.post(`https://api.twitch.tv/helix/channels/followed`,
      { broadcaster_id: broadcasterId, user_id: userId },
      { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' } }
    );
    return;
  } catch (e: any) {
    logger.warn('Helix follow failed, trying GQL follow:', e?.response?.status);
  }

  // Fallback: GQL follow mutation
  const resp = await axios.post('https://gql.twitch.tv/gql', [{
    operationName: 'FollowButton_FollowUser',
    variables: { input: { targetID: broadcasterId, disableNotifications: false } },
    extensions: { persistedQuery: { version: 1, sha256Hash: '800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b715d7e4a23' } }
  }], {
    headers: {
      'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Authorization': `OAuth ${userToken}`,
      'Content-Type': 'application/json',
    }
  });
  const errors = resp.data?.[0]?.errors;
  if (errors?.length) throw new Error(errors[0].message);
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
  const viewers: Record<number, ViewerSimulator> = {};
  const runtimeTokens: Record<number, string> = {}; // tokens saved via /auth flow
  function getUserToken(botIndex: number): string {
    return runtimeTokens[botIndex] || process.env[`BOT${botIndex + 1}_USER_TOKEN`] || '';
  }

  logger.info(`Phrases: ${PHRASES_FILE} | Storage: ${DATA_DIR}`);

  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        watching: !!viewers[i],
        hasUserToken: !!getUserToken(i),
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
      storageOk: DATA_DIR === '/data'
    });
  });

  // ── OAuth for user tokens ─────────────────────────
  app.get('/auth', (req, res) => {
    const botIdx = parseInt(String(req.query.bot || '0'));
    const clientId = process.env.TWITCH_CLIENT_ID!;
    const host = req.headers.host || 'localhost';
    const proto = host.includes('railway.app') ? 'https' : 'http';
    const redirectUri = `${proto}://${host}/auth/callback`;
    const scope = 'user:edit:follows user:read:email';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&state=${botIdx}&force_verify=true`;
    res.redirect(url);
  });

  // Token fragment comes back as #access_token= - handle via HTML page
  app.get('/auth/callback', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth</title>
<style>body{background:#0e0e10;color:#efeff1;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px}
.ok{color:#00c853;font-size:24px}.err{color:#e53935}</style></head><body>
<div id="msg">Авторизация...</div>
<script>
const hash=window.location.hash.substring(1);
const params=new URLSearchParams(hash);
const token=params.get('access_token');
const state=params.get('state')||'0';
const msg=document.getElementById('msg');
if(token){
  fetch('/auth/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,botIndex:parseInt(state)})})
  .then(r=>r.json()).then(d=>{
    if(d.ok){msg.innerHTML='<span class="ok">✓ Авторизован: '+d.botName+'</span><br><small>Можно закрыть это окно</small>';}
    else{msg.innerHTML='<span class="err">Ошибка: '+d.error+'</span>';}
  }).catch(e=>msg.innerHTML='<span class="err">Ошибка: '+e+'</span>');
}else{
  const err=params.get('error_description')||params.get('error')||'Токен не получен';
  msg.innerHTML='<span class="err">'+err+'</span><br><small>Закрой окно и попробуй снова</small>';
}
</script></body></html>`);
  });

  app.post('/auth/save', async (req, res) => {
    const { token, botIndex = 0 } = req.body;
    if (!token) return res.status(400).json({ error: 'No token' });
    try {
      const meResp = await axios.get('https://api.twitch.tv/helix/users', {
        headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${token}` }
      });
      const username = meResp.data.data[0]?.login?.toLowerCase();
      if (!username) throw new Error('Could not verify token');
      // Store as BOT{n}_USER_TOKEN equivalent in memory
      const idx = parseInt(String(botIndex));
      // Save to a runtime map (persists until restart)
      runtimeTokens[idx] = token;
      logger.info(`Saved runtime user token for bot[${idx}] = ${username}`);
      io.emit('bot-state', {});
      res.json({ ok: true, botName: username });
    } catch (e: any) {
      res.status(500).json({ error: e?.response?.data?.message || e?.message || 'Failed' });
    }
  });

  // ── Follow ────────────────────────────────────────
  app.post('/api/follow', async (req, res) => {
    const idx = parseInt(String(req.body.botIndex || 0));
    const token = getUserToken(idx);
    const botName = bots[idx]?.getUsername?.() || `Bot${idx + 1}`;
    if (!token) {
      return res.status(400).json({
        error: `Нет токена. Добавь BOT${idx + 1}_USER_TOKEN в Railway Variables`,
        needsToken: true
      });
    }
    try {
      const broadcasterId = await getChannelId(getChannelName());
      await followChannel(token, broadcasterId);
      logger.info(`Bot ${botName} followed ${getChannelName()}`);
      res.json({ ok: true, botName });
    } catch (e: any) {
      logger.error(`Follow error for ${botName}:`, e?.response?.data || e?.message);
      res.status(500).json({ error: e?.response?.data?.message || e?.message || 'Follow failed' });
    }
  });

  app.post('/api/follow-all', async (_req, res) => {
    const results: any[] = [];
    let broadcasterId = '';
    try { broadcasterId = await getChannelId(getChannelName()); }
    catch (e) { return res.status(500).json({ error: 'Could not get channel ID' }); }
    for (let i = 0; i < bots.length; i++) {
      const token = getUserToken(i);
      const botName = bots[i]?.getUsername?.() || `Bot${i + 1}`;
      if (!token) { results.push({ botName, ok: false, error: `Нет BOT${i + 1}_USER_TOKEN` }); continue; }
      try {
        await followChannel(token, broadcasterId);
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 600));
      } catch (e: any) {
        results.push({ botName, ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // ── Watch ─────────────────────────────────────────
  app.post('/api/watch', async (req, res) => {
    const idx = parseInt(String(req.body.botIndex || 0));
    const botName = bots[idx]?.getUsername?.() || `Bot${idx + 1}`;
    if (viewers[idx]) {
      viewers[idx].stop(); delete viewers[idx];
      io.emit('viewer-state', { botIndex: idx, watching: false });
      return res.json({ ok: true, watching: false, botName });
    }
    try {
      const sim = new ViewerSimulator(getChannelName());
      await sim.start();
      viewers[idx] = sim;
      io.emit('viewer-state', { botIndex: idx, watching: true });
      res.json({ ok: true, watching: true, botName });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.post('/api/watch-all', async (_req, res) => {
    const results: any[] = [];
    for (let i = 0; i < bots.length; i++) {
      const botName = bots[i]?.getUsername?.() || `Bot${i+1}`;
      if (viewers[i]?.running) {
        results.push({ botName, ok: true, already: true });
        continue;
      }
      try {
        if (viewers[i]) { viewers[i].stop(); delete viewers[i]; }
        const sim = new ViewerSimulator(getChannelName());
        await sim.start();
        viewers[i] = sim;
        io.emit('viewer-state', { botIndex: i, watching: true });
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 1200));
      } catch (e: any) {
        results.push({ botName, ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // ── Messages ──────────────────────────────────────
  function emitSend(message: string, idx: number) {
    aiService.emit(`manualMessage_${idx}`, message);
    io.emit('bot-sent', { message, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`, manual: true, time: Date.now() });
  }

  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    emitSend(message, parseInt(String(botIndex)) || 0);
    res.json({ ok: true });
  });
  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    emitSend(phrase, parseInt(String(botIndex)) || 0);
    res.json({ ok: true, phrase });
  });
  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    emitSend(phrase, parseInt(String(botIndex)) || 0);
    res.json({ ok: true });
  });

  // ── Phrase CRUD ───────────────────────────────────
  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body;
    if (!group || !phrase) return res.status(400).json({ error: 'Missing' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase); savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete', (req, res) => {
    const { group, phrase } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    phraseGroups[group] = phraseGroups[group].filter(p => p !== phrase);
    if (!phraseGroups[group].length) delete phraseGroups[group];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/rename-group', (req, res) => {
    const { oldName, newName } = req.body;
    if (!phraseGroups[oldName] || !newName) return res.status(400).json({ error: 'Invalid' });
    phraseGroups[newName] = phraseGroups[oldName]; delete phraseGroups[oldName];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete-group', (req, res) => {
    const { group } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    delete phraseGroups[group]; savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body; const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Not found' });
    botStates[botIndex] = !botStates[botIndex];
    botStates[botIndex] ? bot.connect?.() : bot.disconnect?.();
    io.emit('bot-state', { botIndex, enabled: botStates[botIndex] });
    res.json({ ok: true, enabled: botStates[botIndex] });
  });

  // ── Events ────────────────────────────────────────
  aiService.on('incomingChat', (d: any) => io.emit('incoming-chat', d));
  aiService.on('message', (msg: string) => {
    io.emit('bot-sent', { message: msg, botIndex: 0, botName: bots[0]?.getUsername?.() || 'Бот', manual: false, time: Date.now() });
  });
  aiService.on('transcription', (text: string) => io.emit('transcription', { text, time: Date.now() }));
  io.on('viewer-state', (d: any) => io.emit('viewer-state', d));

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => logger.info(`Dashboard at port ${PORT}`));
  return { app, io };
}
