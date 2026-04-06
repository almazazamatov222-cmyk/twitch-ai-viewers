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
const TOKENS_FILE = path.join(DATA_DIR, 'follow_tokens.json');

const DEFAULT_PHRASES: Record<string, string[]> = {
  'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
  'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
  'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
};

function loadPhrases(): Record<string, string[]> {
  try { if (fs.existsSync(PHRASES_FILE)) return JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8')); } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}
function savePhrases(g: Record<string, string[]>) { try { fs.writeFileSync(PHRASES_FILE, JSON.stringify(g, null, 2)); } catch (_) {} }

const followTokens: Record<number, string> = (() => {
  try { if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch (_) {}
  return {};
})();
function saveFollowTokens() { try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(followTokens, null, 2)); logger.info(`Tokens saved: ${JSON.stringify(Object.keys(followTokens))}`); } catch (_) {} }

function getChannelName(): string {
  const ch = process.env.TWITCH_CHANNEL || '';
  return ch.includes('twitch.tv/') ? ch.split('twitch.tv/')[1].split('/')[0].split('?')[0] : ch;
}

const GQL_HEADERS = {
  'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Origin': 'https://www.twitch.tv',
  'Referer': 'https://www.twitch.tv/',
};

async function gqlFollow(token: string, broadcasterId: string): Promise<void> {
  const cleanToken = token.replace(/^oauth:/i, '').trim();
  logger.info(`GQL follow: broadcasterId=${broadcasterId}, token=${cleanToken.slice(0,8)}...`);
  const resp = await axios.post('https://gql.twitch.tv/gql', [{
    operationName: 'FollowButton_FollowUser',
    variables: { input: { targetID: broadcasterId, disableNotifications: false } },
    extensions: { persistedQuery: { version: 1, sha256Hash: '800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b715d7e4a23' } }
  }], {
    headers: { ...GQL_HEADERS, 'Authorization': `OAuth ${cleanToken}` }
  });
  logger.info(`GQL follow response:`, JSON.stringify(resp.data?.[0]));
  const errors = resp.data?.[0]?.errors;
  if (errors?.length) throw new Error(errors[0].message);
}

async function getChannelId(name: string): Promise<string> {
  const resp = await axios.post('https://gql.twitch.tv/gql',
    { query: `{ user(login: "${name}") { id } }` },
    { headers: GQL_HEADERS, timeout: 10000 }
  );
  const id = resp.data?.data?.user?.id;
  if (!id) throw new Error(`Channel "${name}" not found`);
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
  const viewers: Record<number, ViewerSimulator> = {};

  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        watching: !!viewers[i]?.running,
        hasFollowToken: !!followTokens[i],
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
    });
  });

  // ── Follow OAuth ──────────────────────────────────────────────────────────
  // Uses USER'S OWN Twitch app (TWITCH_CLIENT_ID) because they registered
  // https://twitch-ai-viewers-production.up.railway.app/auth/callback in their app
  // OAuth - uses user's own TWITCH_CLIENT_ID with registered redirect URL /auth/callback
  app.get('/auth/follow', (req, res) => {
    const botIdx = parseInt(String(req.query.bot || '0'));
    const host = req.headers.host || 'localhost';
    const proto = host.includes('railway') ? 'https' : 'http';
    const clientId = process.env.TWITCH_CLIENT_ID!;
    const redirectUri = `${proto}://${host}/auth/callback`;
    const scope = 'user:edit:follows';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&state=${botIdx}&force_verify=true`;
    logger.info(`Follow auth redirect for bot[${botIdx}]: ${redirectUri}`);
    res.redirect(url);
  });

  app.get('/auth/callback', (_req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth</title>
<style>body{background:#0e0e10;color:#efeff1;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;margin:0;text-align:center}.ok{color:#00c853;font-size:22px}.err{color:#e53935;font-size:18px}p{opacity:.6;font-size:14px}</style></head><body>
<div id="msg">Авторизация...</div>
<script>
const p=new URLSearchParams(window.location.hash.substring(1));
const t=p.get('access_token'),s=p.get('state')||'0';
const m=document.getElementById('msg');
if(t){
  const isFollow=true;
  const botIdx=parseInt(s);
  fetch('/auth/save',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:t,botIndex:botIdx,type:isFollow?'follow':'general'})})
  .then(r=>r.json()).then(d=>{
    m.innerHTML=d.ok
      ?'<div class="ok">✓ '+d.botName+'</div><p>Закрой окно и нажми ♥ снова</p>'
      :'<div class="err">'+d.error+'</div>';
  }).catch(e=>m.innerHTML='<div class="err">'+e+'</div>');
}else{
  const err=p.get('error_description')||p.get('error')||'Нет токена';
  m.innerHTML='<div class="err">'+err+'</div><p>Закрой окно и попробуй снова</p>';
}
</script></body></html>`);
  });

  app.post('/auth/save', async (req, res) => {
    const { token, botIndex = 0 } = req.body;
    if (!token) return res.status(400).json({ error: 'No token' });
    try {
      const validate = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `OAuth ${token}` }
      });
      const username = validate.data.login;
      if (!username) throw new Error('Invalid token from Twitch validate');
      const idx = parseInt(String(botIndex));
      followTokens[idx] = token;
      saveFollowTokens();
      // Verify it was saved
      const saved = followTokens[idx];
      logger.info(`Token SAVED bot[${idx}]=${username}, token length=${saved?.length}, file=${TOKENS_FILE}`);
      logger.info(`All tokens now: ${JSON.stringify(Object.fromEntries(Object.entries(followTokens).map(([k,v])=>[k,v?.slice(0,8)+'...'])))}`);
      io.emit('bot-state', {});
      res.json({ ok: true, botName: username });
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || 'Failed';
      logger.error('auth/save error:', msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/follow', async (req, res) => {
    const idx = parseInt(String(req.body.botIndex || 0));
    const botName = bots[idx]?.getUsername?.() || `Bot${idx + 1}`;

    // Debug: log all known tokens
    const knownTokens = Object.keys(followTokens);
    logger.info(`Follow request for bot[${idx}], known token indices: [${knownTokens.join(',')}], hasToken: ${!!followTokens[idx]}`);

    if (!followTokens[idx]) {
      const host = req.headers.host;
      const proto = (host || '').includes('localhost') ? 'http' : 'https';
      return res.status(401).json({
        error: 'Нужна авторизация',
        authUrl: `${proto}://${host}/auth/follow?bot=${idx}`
      });
    }

    try {
      logger.info(`Following ${getChannelName()} as bot[${idx}] token=${followTokens[idx]?.slice(0,8)}...`);
      const broadcasterId = await getChannelId(getChannelName());
      logger.info(`BroadcasterId: ${broadcasterId}`);
      await gqlFollow(followTokens[idx], broadcasterId);
      logger.info(`SUCCESS: ${botName} followed ${getChannelName()}`);
      res.json({ ok: true, botName });
    } catch (e: any) {
      logger.error(`Follow FAILED for ${botName}:`, JSON.stringify(e?.response?.data) || e?.message);
      if (e?.response?.status === 401) {
        delete followTokens[idx]; saveFollowTokens();
        const host = req.headers.host;
        const proto = (host || '').includes('localhost') ? 'http' : 'https';
        return res.status(401).json({ error: 'Токен истёк', authUrl: `${proto}://${host}/auth/follow?bot=${idx}` });
      }
      res.status(500).json({ error: e?.response?.data?.[0]?.errors?.[0]?.message || e?.message || 'Follow failed' });
    }
  });

  app.post('/api/follow-all', async (_req, res) => {
    const results: any[] = [];
    let broadcasterId = '';
    try { broadcasterId = await getChannelId(getChannelName()); }
    catch (e) { return res.status(500).json({ error: 'Channel not found' }); }

    for (let i = 0; i < bots.length; i++) {
      const botName = bots[i]?.getUsername?.() || `Bot${i + 1}`;
      if (!followTokens[i]) { results.push({ botName, ok: false, error: 'Нет токена' }); continue; }
      try {
        await gqlFollow(followTokens[i], broadcasterId);
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 800));
      } catch (e: any) {
        if (e?.response?.status === 401) { delete followTokens[i]; saveFollowTokens(); }
        results.push({ botName, ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // ── Watch ─────────────────────────────────────────────────────────────────
  app.post('/api/watch', async (req, res) => {
    const idx = parseInt(String(req.body.botIndex || 0));
    const botName = bots[idx]?.getUsername?.() || `Bot${idx + 1}`;
    if (viewers[idx]?.running) {
      viewers[idx].stop(); delete viewers[idx];
      io.emit('viewer-state', { botIndex: idx, watching: false });
      return res.json({ ok: true, watching: false, botName });
    }
    try {
      if (viewers[idx]) { viewers[idx].stop(); delete viewers[idx]; }
      const sim = new ViewerSimulator(getChannelName());
      await sim.start();
      viewers[idx] = sim;
      io.emit('viewer-state', { botIndex: idx, watching: true });
      res.json({ ok: true, watching: true, botName });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post('/api/watch-all', async (_req, res) => {
    const results: any[] = [];
    for (let i = 0; i < bots.length; i++) {
      const botName = bots[i]?.getUsername?.() || `Bot${i + 1}`;
      if (viewers[i]?.running) { results.push({ botName, ok: true, already: true }); continue; }
      try {
        if (viewers[i]) { viewers[i].stop(); delete viewers[i]; }
        const sim = new ViewerSimulator(getChannelName());
        await sim.start();
        viewers[i] = sim;
        io.emit('viewer-state', { botIndex: i, watching: true });
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 1200));
      } catch (e: any) { results.push({ botName, ok: false, error: e?.message }); }
    }
    res.json({ results });
  });

  // ── Messages ──────────────────────────────────────────────────────────────
  function emitSend(message: string, idx: number) {
    aiService.emit(`manualMessage_${idx}`, message);
    io.emit('bot-sent', { message, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`, manual: true, time: Date.now() });
  }

  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    emitSend(message, parseInt(String(botIndex)) || 0); res.json({ ok: true });
  });
  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    emitSend(phrase, parseInt(String(botIndex)) || 0); res.json({ ok: true, phrase });
  });
  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    emitSend(phrase, parseInt(String(botIndex)) || 0); res.json({ ok: true });
  });

  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body; if (!group || !phrase) return res.status(400).json({ error: 'Missing' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase); savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete', (req, res) => {
    const { group, phrase } = req.body; if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    phraseGroups[group] = phraseGroups[group].filter(p => p !== phrase);
    if (!phraseGroups[group].length) delete phraseGroups[group];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/rename-group', (req, res) => {
    const { oldName, newName } = req.body; if (!phraseGroups[oldName] || !newName) return res.status(400).json({ error: 'Invalid' });
    phraseGroups[newName] = phraseGroups[oldName]; delete phraseGroups[oldName];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete-group', (req, res) => {
    const { group } = req.body; if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    delete phraseGroups[group]; savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body; const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Not found' });
    botStates[botIndex] = !botStates[botIndex];
    botStates[botIndex] ? bot.connect?.() : bot.disconnect?.();
    io.emit('bot-state', { botIndex, enabled: botStates[botIndex] }); res.json({ ok: true, enabled: botStates[botIndex] });
  });

  aiService.on('transcription', (text: string) => io.emit('transcription', { text, time: Date.now() }));

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => logger.info(`Dashboard at port ${PORT}`));
  return { app, io };
}
