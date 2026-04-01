import axios from 'axios';
import { EventEmitter } from 'events';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FfmpegCommand } from 'fluent-ffmpeg';
import { Groq } from 'groq-sdk';
import { execSync } from 'child_process';
import { logger } from './logger';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface TwitchChannelInfo {
  title: string;
  description: string;
  gameName: string;
  viewerCount: number;
  isLive: boolean;
}

export class AIService extends EventEmitter {
  private groq: Groq | null = null;
  private isCapturing: boolean = false;
  private currentProcess: FfmpegCommand | null = null;
  private tempAudioFile: string | null = null;
  private accessToken: string | null = null;
  private _currentChannelInfo: TwitchChannelInfo | null = null;
  private messageInterval: number;
  private isProcessing: boolean = false;
  private lastProcessedTime: number = 0;
  private processingLock: boolean = false;
  private lastTranscriptionHash: string = '';
  private lastEmittedTranscription: string = '';
  private lastEmittedTime: number = 0;

  constructor() {
    super();
    logger.info('AIService initialized');
    this.messageInterval = parseInt(process.env.MESSAGE_INTERVAL || '5000');

    if (process.env.GROQ_API_KEY) {
      this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      logger.info('Groq client initialized');
    }
  }

  public get currentChannelInfo(): TwitchChannelInfo | null {
    return this._currentChannelInfo;
  }

  private set currentChannelInfo(info: TwitchChannelInfo | null) {
    this._currentChannelInfo = info;
  }

  private async generateAccessToken(): Promise<string> {
    try {
      logger.info('Generating new access token...');
      const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
          client_id: process.env.TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
          grant_type: 'client_credentials'
        }
      });
      const { access_token } = response.data;
      logger.info('New access token generated successfully');
      return access_token;
    } catch (error) {
      logger.error('Error generating access token:', error);
      throw error;
    }
  }

  private async getChannelInfo(channelName: string): Promise<TwitchChannelInfo> {
    try {
      logger.info('Fetching channel info for:', channelName);

      if (!this.accessToken) {
        this.accessToken = await this.generateAccessToken();
      }

      const userResponse = await axios.get(`https://api.twitch.tv/helix/users?login=${channelName}`, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      if (userResponse.data.data.length === 0) {
        throw new Error(`Channel "${channelName}" not found`);
      }

      const userId = userResponse.data.data[0].id;
      logger.info('Found user ID:', userId);

      const channelResponse = await axios.get(`https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      const channelData = channelResponse.data.data[0];

      const streamResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${userId}`, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      const streamData = streamResponse.data.data[0];

      const channelInfo: TwitchChannelInfo = {
        title: streamData?.title || channelData.title,
        description: channelData.description || '',
        gameName: streamData?.game_name || 'Not specified',
        viewerCount: streamData?.viewer_count || 0,
        isLive: !!streamData
      };

      logger.info('Channel info retrieved:', {
        title: channelInfo.title,
        game: channelInfo.gameName,
        viewers: channelInfo.viewerCount,
        isLive: channelInfo.isLive
      });

      return channelInfo;
    } catch (error) {
      logger.error('Error fetching channel info:', error);
      throw error;
    }
  }

  public get isVoiceCaptureActive(): boolean {
    return this.isCapturing;
  }

  public async startVoiceCapture(channel: string): Promise<void> {
    if (this.isCapturing) return;

    try {
      const channelName = channel.startsWith('https://www.twitch.tv/')
        ? channel.split('/').pop()
        : channel;

      if (!channelName) throw new Error('Invalid channel name');

      logger.info('Starting voice capture for channel:', channelName);

      this.currentChannelInfo = await this.getChannelInfo(channelName);

      if (!this.currentChannelInfo.isLive) {
        logger.warn(`Channel "${channelName}" is not live yet. Will retry in 60 seconds...`);
        // Don't throw - retry after delay
        setTimeout(() => {
          this.startVoiceCapture(channel).catch(e => logger.error('Retry voice capture error:', e));
        }, 60000);
        return;
      }

      this.isCapturing = true;
      this.captureLoop(channelName).catch(error => {
        logger.error('Error in capture loop:', error);
        this.isCapturing = false;
        // Auto-restart after 30 seconds
        setTimeout(() => {
          logger.info('Restarting capture loop...');
          this.startVoiceCapture(channel).catch(e => logger.error('Restart error:', e));
        }, 30000);
      });
    } catch (error) {
      logger.error('Error starting voice capture:', error);
      throw error;
    }
  }

  private async captureLoop(channelName: string): Promise<void> {
    let isProcessing = false;

    while (this.isCapturing) {
      try {
        if (isProcessing) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        const streamUrl = await this.getStreamUrl(channelName);
        this.tempAudioFile = join(tmpdir(), `twitch-audio-${Date.now()}.wav`);

        isProcessing = true;
        await new Promise<void>((resolve, reject) => {
          this.currentProcess = ffmpeg(streamUrl)
            .inputOptions([
              '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              '-loglevel', 'error',
              '-f', 'hls',
            ])
            .outputOptions([
              '-f', 'wav',
              '-acodec', 'pcm_s16le',
              '-ac', '1',
              '-ar', '16000',
              '-vn'
            ])
            .duration(parseInt(process.env.TRANSCRIPT_DURATION || '60000') / 1000)
            .on('error', (err: Error) => {
              isProcessing = false;
              reject(err);
            })
            .on('end', async () => {
              if (this.isCapturing) {
                try {
                  await this.processAudioChunk();
                } finally {
                  isProcessing = false;
                }
              } else {
                isProcessing = false;
              }
              resolve();
            })
            .save(this.tempAudioFile!);
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        isProcessing = false;
        logger.error('Error in capture loop:', error);
        this.stopVoiceCapture();
      }
    }
  }

  public stopVoiceCapture(): void {
    if (!this.isCapturing) return;

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    if (this.tempAudioFile) {
      try { unlinkSync(this.tempAudioFile); } catch (error) { }
      this.tempAudioFile = null;
    }

    this.isCapturing = false;
    logger.info('Voice capture stopped');
  }

  private async processAudioChunk(): Promise<void> {
    if (!this.tempAudioFile || this.isProcessing || this.processingLock) return;

    this.processingLock = true;
    this.isProcessing = true;

    try {
      if (!existsSync(this.tempAudioFile)) {
        logger.warn('Temporary audio file not found:', this.tempAudioFile);
        return;
      }

      const audioData = await this.readAudioFile(this.tempAudioFile);

      if (!Buffer.isBuffer(audioData) || audioData.length === 0) {
        logger.warn('Invalid or empty audio data received');
        return;
      }

      const transcribedText = await this.processAudioToText(audioData);
      const now = Date.now();
      const currentHash = transcribedText ? transcribedText.trim() : '';

      if (currentHash &&
        (currentHash !== this.lastTranscriptionHash ||
          now - this.lastProcessedTime >= this.messageInterval)) {

        logger.info('Transcription received:', transcribedText);
        this.lastTranscriptionHash = currentHash;
        this.lastProcessedTime = now;

        if (transcribedText !== this.lastEmittedTranscription &&
          now - this.lastEmittedTime >= this.messageInterval) {
          logger.info('Emitting transcription event');
          this.emit('transcription', transcribedText);
          this.lastEmittedTranscription = transcribedText;
          this.lastEmittedTime = now;

          const message = await this.generateMessage(JSON.stringify({
            lastTranscription: transcribedText,
            isStreamerMessage: true
          }));

          if (message && message.trim() !== '') {
            logger.info('Generated message:', message);
            this.emit('message', message);
          }
        }
      } else {
        logger.info('Skipping duplicate transcription');
      }
    } catch (error) {
      logger.error('Error processing audio chunk:', error);
    } finally {
      try {
        if (this.tempAudioFile && existsSync(this.tempAudioFile)) {
          unlinkSync(this.tempAudioFile);
        }
      } catch (error) { }
      this.tempAudioFile = null;
      this.isProcessing = false;
      this.processingLock = false;
    }
  }

  private readAudioFile(filePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      fs.readFile(filePath, (err: Error | null, data: Buffer) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  public async processAudioToText(audioData: Buffer): Promise<string> {
    try {
      const language = process.env.ORIGINAL_STREAM_LANGUAGE || 'en';
      const tempFile = join(tmpdir(), `whisper-${Date.now()}.wav`);
      const fs = require('fs');
      fs.writeFileSync(tempFile, audioData);

      if (!this.groq) {
        throw new Error('Groq client not initialized. Please set GROQ_API_KEY.');
      }

      const response = await this.groq.audio.transcriptions.create({
        file: fs.createReadStream(tempFile),
        model: "whisper-large-v3-turbo",
        language: language,
        response_format: "text"
      });

      fs.unlinkSync(tempFile);

      if (!response || typeof response !== 'string') {
        throw new Error('Invalid transcription response from Groq');
      }

      return response;
    } catch (error) {
      logger.error('Error processing audio to text:', error);
      throw error;
    }
  }

  // ============================================================
  // ИСПРАВЛЕНО: используем streamlink вместо сломанного GQL API
  // ============================================================
  private async getStreamUrl(channelName: string): Promise<string> {
    try {
      logger.info(`Getting stream URL for channel: ${channelName} via streamlink`);

      // Попробуем streamlink (установлен через postinstall)
      try {
        const url = execSync(
          `streamlink --stream-url https://www.twitch.tv/${channelName} best 2>/dev/null`,
          { timeout: 30000 }
        ).toString().trim();

        if (url && url.startsWith('http')) {
          logger.info('Got stream URL via streamlink');
          return url;
        }
      } catch (e) {
        logger.warn('streamlink failed, trying fallback method...');
      }

      // Запасной метод: получаем HLS URL через Twitch API напрямую
      if (!this.accessToken) {
        this.accessToken = await this.generateAccessToken();
      }

      // Получаем токен через официальный API
      const tokenResponse = await axios.post(
        `https://id.twitch.tv/oauth2/token`,
        null,
        {
          params: {
            client_id: process.env.TWITCH_CLIENT_ID,
            client_secret: process.env.TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials'
          }
        }
      );

      const token = tokenResponse.data.access_token;

      // Проверяем что стрим онлайн
      const userResp = await axios.get(
        `https://api.twitch.tv/helix/users?login=${channelName}`,
        { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${token}` } }
      );

      const userId = userResp.data.data[0]?.id;
      if (!userId) throw new Error('User not found');

      const streamResp = await axios.get(
        `https://api.twitch.tv/helix/streams?user_id=${userId}`,
        { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${token}` } }
      );

      if (!streamResp.data.data[0]) {
        throw new Error(`Channel ${channelName} is not live`);
      }

      // Используем публичный HLS endpoint (без токена — для аудио достаточно)
      const hlsUrl = `https://usher.ttvnw.net/api/channel/hls/${channelName}.m3u8?allow_source=true&allow_spectre=true&fast_bread=true`;
      logger.info('Using fallback HLS URL');
      return hlsUrl;

    } catch (error) {
      logger.error('Error getting stream URL:', error);
      throw error;
    }
  }

  public async generateMessage(context?: string): Promise<string> {
    try {
      if (!this.currentChannelInfo) {
        logger.warn('No channel info available for message generation');
        return '';
      }

      let parsedContext: any = {};
      try {
        if (context) parsedContext = JSON.parse(context);
      } catch (error) {
        parsedContext = { rawText: context };
      }

      if (!parsedContext.lastTranscription && !parsedContext.chatMessage) {
        logger.info('No transcription or chat message context available');
        return '';
      }

      if (parsedContext.lastTranscription && parsedContext.lastTranscription.length < 10) {
        logger.warn('Transcription too short for message generation');
        return '';
      }

      const channelContext = `
        Channel Title: ${this.currentChannelInfo.title}
        Game: ${this.currentChannelInfo.gameName}
        Viewers: ${this.currentChannelInfo.viewerCount}
        Language: ${process.env.ORIGINAL_STREAM_LANGUAGE || 'en'}
      `;

      const lastTranscription = parsedContext.lastTranscription
        ? `The streamer just said: "${parsedContext.lastTranscription}"`
        : '';

      const chatContext = parsedContext.chatMessage
        ? `A viewer just said: "${parsedContext.chatMessage}"`
        : '';

      const prompt = `
        You are a Twitch viewer watching this stream. Generate a natural, engaging message that a real viewer would type in chat.
        
        Stream Context:
        ${channelContext}
        
        ${lastTranscription}
        ${chatContext}
        
        Guidelines:
        - Write as if you're a real viewer enjoying the stream
        - Keep messages short and casual (max 50 characters)
        - Use emojis in only 20% of messages
        - Write in the stream's language (${process.env.ORIGINAL_STREAM_LANGUAGE || 'en'})
        - Don't mention that you're a bot or AI
        - Don't repeat what the streamer said - respond naturally to it
        - IMPORTANT: Generate JUST the chat message, nothing else.
      `;

      if (!this.groq) throw new Error('Groq client not initialized.');

      const response = await this.groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a Twitch viewer. Generate natural chat messages. Never repeat what the streamer said."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 50,
        temperature: 0.7
      });

      return response.choices[0].message?.content?.trim() || '';
    } catch (error) {
      logger.error('Error generating message:', error);
      return '';
    }
  }
}
