import { Bot } from './bot';
import { AIService } from './ai';
import { logger } from './logger';
import { startDashboardServer } from './server';
import { PERSONALITIES, BotMemory } from './personalities';
import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = ['TWITCH_CHANNEL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'GROQ_API_KEY'];
for (const v of requiredEnvVars) {
  if (!process.env[v]) throw new Error(`Missing env var: ${v}`);
}

const aiService = new AIService();
const bots: Bot[] = [];
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down...');
  for (const bot of bots) { try { bot.disconnect(); } catch (_) {} }
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

// Shared context: recent messages from all sources
const sharedContext = {
  recentTranscription: '',
  recentChat: [] as { username: string; message: string }[],
  recentBotMessages: [] as { botName: string; message: string }[],
};

function addToSharedChat(username: string, message: string) {
  sharedContext.recentChat.push({ username, message });
  if (sharedContext.recentChat.length > 10) sharedContext.recentChat.shift();
}

function addBotMessage(botName: string, message: string) {
  sharedContext.recentBotMessages.push({ botName, message });
  if (sharedContext.recentBotMessages.length > 8) sharedContext.recentBotMessages.shift();
}

function buildContext(memory: BotMemory, trigger: 'timer' | 'chat' | 'crosstalk'): string {
  const parts: string[] = [];

  if (sharedContext.recentTranscription)
    parts.push(`Стример говорит: "${sharedContext.recentTranscription.slice(0, 200)}"`);

  if (sharedContext.recentChat.length > 0) {
    const chatLines = sharedContext.recentChat.slice(-4)
      .map(m => `${m.username}: ${m.message}`).join('\n');
    parts.push(`Последние сообщения чата:\n${chatLines}`);
  }

  if (trigger === 'crosstalk' && sharedContext.recentBotMessages.length > 0) {
    const botLines = sharedContext.recentBotMessages.slice(-3)
      .map(m => `${m.botName}: ${m.message}`).join('\n');
    parts.push(`Другие боты написали:\n${botLines}`);
  }

  const myRecent = memory.getContext();
  if (myRecent) parts.push(myRecent);

  return parts.join('\n\n');
}

async function generateForBot(bot: Bot, memory: BotMemory, trigger: 'timer' | 'chat' | 'crosstalk'): Promise<void> {
  if (!bot.isBotConnected()) return;

  const idx = bot.getBotIndex();
  const personality = PERSONALITIES[idx % PERSONALITIES.length];

  try {
    const contextStr = buildContext(memory, trigger);
    if (!contextStr.trim() && trigger === 'timer') {
      // No context at all - generate based on game/stream only
    }

    const contextJson = JSON.stringify({
      lastTranscription: sharedContext.recentTranscription.slice(0, 300),
      chatMessage: sharedContext.recentChat.slice(-2).map(m => `${m.username}: ${m.message}`).join(' | '),
      botMemory: memory.getContext(),
      crossTalk: trigger === 'crosstalk'
        ? sharedContext.recentBotMessages.slice(-2).map(m => `${m.botName}: ${m.message}`).join(' | ')
        : '',
      trigger,
    });

    const msg = await aiService.generateMessage(contextJson, personality.system);
    if (msg?.trim()) {
      memory.add(msg);
      addBotMessage(bot.getUsername(), msg);
      bot.sendAIMessage(msg);
      logger.info(`Bot[${idx}] ${trigger}: "${msg}"`);
    }
  } catch (e) {
    logger.error(`Bot[${idx}] generate error:`, e);
  }
}

// Schedule next message for a bot with jitter
function scheduleBot(bot: Bot, memory: BotMemory) {
  const idx = bot.getBotIndex();
  const personality = PERSONALITIES[idx % PERSONALITIES.length];
  const delay = personality.minInterval +
    Math.random() * (personality.maxInterval - personality.minInterval);

  setTimeout(async () => {
    if (isShuttingDown) return;
    await generateForBot(bot, memory, 'timer');
    scheduleBot(bot, memory); // reschedule
  }, delay);
}

async function main() {
  logger.info('Starting Twitch AI Viewers');

  const botCredentials: { username: string; oauth: string }[] = [];
  let i = 1;
  while (true) {
    const username = process.env[`BOT${i}_USERNAME`];
    const oauth = process.env[`BOT${i}_OAUTH_TOKEN`] || process.env[`BOT${i}_OAUTH`];
    if (!username || !oauth) break;
    botCredentials.push({ username, oauth });
    i++;
  }

  if (!botCredentials.length) throw new Error('No bot credentials');
  logger.info(`Found ${botCredentials.length} bot(s)`);

  const channelUrl = process.env.TWITCH_CHANNEL!;
  const channelName = channelUrl.includes('twitch.tv/')
    ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0] : channelUrl;
  logger.info(`Channel: ${channelName}`);

  const botMemories: BotMemory[] = [];

  for (let idx = 0; idx < botCredentials.length; idx++) {
    try {
      const bot = new Bot({
        username: botCredentials[idx].username,
        oauth: botCredentials[idx].oauth,
        channel: channelName,
        aiService,
        shouldHandleVoiceCapture: idx === 0,
        botIndex: idx,
      });
      bots.push(bot);
      botMemories.push(new BotMemory(15));
      bot.connect();
    } catch (e) {
      logger.error(`Error creating bot ${botCredentials[idx].username}:`, e);
      botMemories.push(new BotMemory(15)); // keep index aligned
    }
  }

  const { io } = startDashboardServer(aiService, bots);

  // Hook callbacks
  bots.forEach(bot => {
    bot.onAISent = (message, botIndex, botName) => {
      io.emit('bot-sent', { message, botIndex, botName, manual: false, time: Date.now() });
    };
  });

  // Listen for incoming transcription
  aiService.on('transcription', (text: string) => {
    sharedContext.recentTranscription = text;
  });

  // Listen for incoming chat
  aiService.on('incomingChat', (data: any) => {
    addToSharedChat(data.username, data.message);
    io.emit('incoming-chat', data);
  });

  // When transcription arrives → some bots react based on selfTalkChance
  aiService.on('message', (message: string) => {
    if (!message?.trim()) return;
    // Route through personalities independently
    bots.forEach((bot, idx) => {
      const personality = PERSONALITIES[idx % PERSONALITIES.length];
      if (Math.random() < personality.selfTalkChance) {
        generateForBot(bot, botMemories[idx], 'timer');
      }
    });
  });

  // When chat message arrives → some bots reply
  aiService.on('chatMessage', (contextJson: string) => {
    try {
      const ctx = JSON.parse(contextJson);
      addToSharedChat(ctx.username, ctx.chatMessage);

      bots.forEach((bot, idx) => {
        const personality = PERSONALITIES[idx % PERSONALITIES.length];
        if (Math.random() < personality.replyChance) {
          setTimeout(() => {
            generateForBot(bot, botMemories[idx], 'chat');
          }, Math.random() * 8000 + 1000); // 1-9s delay so they don't all reply at once
        }
      });

      // Cross-talk: bots occasionally react to other bots
      if (sharedContext.recentBotMessages.length > 0) {
        bots.forEach((bot, idx) => {
          const personality = PERSONALITIES[idx % PERSONALITIES.length];
          if (Math.random() < personality.crossTalkChance) {
            setTimeout(() => {
              generateForBot(bot, botMemories[idx], 'crosstalk');
            }, Math.random() * 15000 + 5000);
          }
        });
      }
    } catch (_) {}
  });

  // Start independent timers for each bot (staggered start)
  bots.forEach((bot, idx) => {
    const personality = PERSONALITIES[idx % PERSONALITIES.length];
    // Stagger initial messages: 10s, 20s, 35s, 50s
    const initialDelay = (idx + 1) * 10000 + Math.random() * 10000;
    setTimeout(() => {
      if (!isShuttingDown) scheduleBot(bot, botMemories[idx]);
    }, initialDelay);
    logger.info(`Bot[${idx}] timer starts in ${Math.round(initialDelay/1000)}s, interval ${personality.minInterval/1000}-${personality.maxInterval/1000}s`);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    const msg = String(err);
    if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
    logger.error('Uncaught exception:', err);
    shutdown();
  });
  process.on('unhandledRejection', (err) => {
    const msg = String(err);
    if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
    logger.error('Unhandled rejection:', err);
  });
}

main().catch(e => { logger.error('Fatal:', e); shutdown(); });
