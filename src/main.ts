import { Bot } from './bot';
import { AIService } from './ai';
import { logger } from './logger';
import { startDashboardServer } from './server';
import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = ['TWITCH_CHANNEL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'GROQ_API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const aiService = new AIService();
const bots: Bot[] = [];
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return; // prevent cascading shutdown calls
  isShuttingDown = true;
  logger.info('Shutting down...');
  for (const bot of bots) {
    try { bot.disconnect(); } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

async function main() {
  try {
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

    if (botCredentials.length === 0)
      throw new Error('No bot credentials found. Set BOT1_USERNAME and BOT1_OAUTH_TOKEN');

    logger.info(`Found ${botCredentials.length} bot(s)`);

    const channelUrl = process.env.TWITCH_CHANNEL!;
    const channelName = channelUrl.includes('twitch.tv/')
      ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
      : channelUrl;

    logger.info(`Channel: ${channelName}`);

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
        bot.connect();
      } catch (error) {
        logger.error(`Error creating bot ${botCredentials[idx].username}:`, error);
      }
    }

    // Round-robin: distribute AI messages across ALL connected bots
    let rrIndex = 0;
    aiService.on('message', (message: string) => {
      if (!message?.trim()) return;
      // Find next connected bot
      let attempts = 0;
      while (attempts < bots.length) {
        const bot = bots[rrIndex % bots.length];
        rrIndex++;
        attempts++;
        if (bot.isBotConnected()) {
          bot.sendAIMessage(message);
          logger.info(`AI message routed to bot[${bot.getBotIndex()}]: "${message}"`);
          return;
        }
      }
      // Fallback: send to first bot regardless
      if (bots.length > 0) bots[0].sendAIMessage(message);
    });

    startDashboardServer(aiService, bots);

    // Ignore disconnect errors - don't let them trigger shutdown
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (error) => {
      const msg = String(error);
      if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
      logger.error('Uncaught exception:', error);
      shutdown();
    });
    process.on('unhandledRejection', (error) => {
      const msg = String(error);
      if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
      logger.error('Unhandled rejection:', error);
    });

  } catch (error) {
    logger.error('Error in main:', error);
    await shutdown();
  }
}

main();
