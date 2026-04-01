import { Bot } from './bot';
import { AIService } from './ai';
import { logger } from './logger';
import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = [
  'TWITCH_CHANNEL',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'GROQ_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const aiService = new AIService();
const bots: Bot[] = [];

async function shutdown() {
  logger.info('Shutting down...');
  for (const bot of bots) {
    try { bot.disconnect(); } catch (error) { logger.error('Error disconnecting bot:', error); }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  process.exit(0);
}

async function main() {
  try {
    logger.info('Starting Twitch AI Viewers');

    const botCredentials: { username: string; oauth: string }[] = [];
    let botIndex = 1;

    while (true) {
      const username = process.env[`BOT${botIndex}_USERNAME`];
      // Support both BOT1_OAUTH_TOKEN and BOT1_OAUTH
      const oauth = process.env[`BOT${botIndex}_OAUTH_TOKEN`] || process.env[`BOT${botIndex}_OAUTH`];

      if (!username || !oauth) break;

      botCredentials.push({ username, oauth });
      botIndex++;
    }

    if (botCredentials.length === 0) {
      throw new Error('No bot credentials found. Set BOT1_USERNAME and BOT1_OAUTH_TOKEN in environment variables');
    }

    logger.info(`Found ${botCredentials.length} bot(s) in environment variables`);

    const channelUrl = process.env.TWITCH_CHANNEL!;
    const channelName = channelUrl.includes('twitch.tv/')
      ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
      : channelUrl;

    logger.info(`Setting up voice capture for channel: ${channelName}`);

    for (let i = 0; i < botCredentials.length; i++) {
      const credentials = botCredentials[i];
      try {
        const bot = new Bot({
          username: credentials.username,
          oauth: credentials.oauth,
          channel: channelName,
          aiService,
          shouldHandleVoiceCapture: i === 0 // only first bot handles voice
        });
        bots.push(bot);
        bot.connect();
      } catch (error) {
        logger.error(`Error creating bot ${credentials.username}:`, error);
      }
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (error) => { logger.error('Uncaught exception:', error); shutdown(); });
    process.on('unhandledRejection', (error) => { logger.error('Unhandled rejection:', error); shutdown(); });

  } catch (error) {
    logger.error('Error in main:', error);
    await shutdown();
  }
}

main();
