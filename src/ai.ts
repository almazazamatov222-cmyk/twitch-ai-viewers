import axios from 'axios';
import { EventEmitter } from 'events';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FfmpegCommand } from 'fluent-ffmpeg';
import { Groq } from 'groq-sdk';
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
      this.groq = new Groq({
        apiKey: process.env.GROQ_API_KEY
      });
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
          grant_type: 'client_credentials',
          scope: 'user:read:email channel:read:stream_key channel:manage:broadcast'
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

      // First, get the user ID from the channel name
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

      // Now get the channel info using the user ID
      const channelResponse = await axios.get(`https://api.twitch.tv/helix/channels?broadcaster_id=${userId}`, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      const channelData = channelResponse.data.data[0];

      // Get stream info to check if live and get current game
      const streamResponse = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${userId}`, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${this.accessToken}`
        }
      });

      const streamData = streamResponse.data.data[0];

      const channelInfo: TwitchChannelInfo = {
        title: streamData?.title || channelData.title,
        description: channelData.description,
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
      if (axios.isAxiosError(error)) {
        logger.error('API Error Details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data
        });
      }
      throw error;
    }
  }

  public get isVoiceCaptureActive(): boolean {
    return this.isCapturing;
  }

  public async startVoiceCapture(channel: string): Promise<void> {
    if (this.isCapturing) return;
    const channelName = channel.startsWith('https://www.twitch.tv/')
      ? channel.split('/').pop()!
      : channel;
    if (!channelName) throw new Error('Invalid channel name');
    logger.info('Starting voice capture for channel:', channelName);
    try {
      this.currentChannelInfo = await this.getChannelInfo(channelName);
    } catch (e) {
      logger.warn('Could not fetch channel info, proceeding anyway');
    }
    this.isCapturing = true;
    this.captureLoop(channelName).catch(error => {
      logger.error('Error in capture loop:', error);
      this.isCapturing = false;
      logger.info('Retrying voice capture in 60s...');
      setTimeout(() => this.startVoiceCapture(channelName), 60000);
    });
  }

  private async captureLoop(channel: string): Promise<void> {
    let isProcessing = false;

    while (this.isCapturing) {
      try {
        if (isProcessing) {
          logger.info('Previous chunk still processing, waiting...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        const streamUrl = await this.getStreamUrl(channel);
        this.tempAudioFile = join(tmpdir(), `twitch-audio-${Date.now()}.wav`);

        isProcessing = true;
        await new Promise<void>((resolve, reject) => {
          this.currentProcess = ffmpeg(streamUrl)
            .inputOptions([
              '-user_agent', 'Mozilla/5.0',
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
              this.stopVoiceCapture();
              reject(err);
            })
            .on('end', async () => {
              if (this.isCapturing) {
                try {
                  await this.processAudioChunk();
                } finally {
                  isProcessing = false;
                }
                resolve();
              } else {
                isProcessing = false;
                resolve();
              }
            })
            .save(this.tempAudioFile!);
        });

        // Add a small delay between captures to avoid processing the same audio twice
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        isProcessing = false;
        logger.error('Error in capture loop:', error);
        this.stopVoiceCapture();
      }
    }
  }

  public stopVoiceCapture(): void {
    if (!this.isCapturing) {
      return;
    }

    if (this.currentProcess) {
      this.currentProcess.kill('SIGKILL');
      this.currentProcess = null;
    }

    if (this.tempAudioFile) {
      try {
        unlinkSync(this.tempAudioFile);
      } catch (error) { }
      this.tempAudioFile = null;
    }

    this.isCapturing = false;
    logger.info('Voice capture stopped');
  }

  private async processAudioChunk(): Promise<void> {
    if (!this.tempAudioFile || this.isProcessing || this.processingLock) {
      logger.debug('Skipping processAudioChunk - conditions not met:', {
        hasTempFile: !!this.tempAudioFile,
        isProcessing: this.isProcessing,
        processingLock: this.processingLock
      });
      return;
    }

    this.processingLock = true;
    this.isProcessing = true;

    try {
      // Check if file exists before trying to read it
      if (!existsSync(this.tempAudioFile)) {
        logger.warn('Temporary audio file not found:', this.tempAudioFile);
        return;
      }

      const audioData = await this.readAudioFile(this.tempAudioFile);

      // Ensure we have valid audio data
      if (!Buffer.isBuffer(audioData) || audioData.length === 0) {
        logger.warn('Invalid or empty audio data received');
        return;
      }

      const transcribedText = await this.processAudioToText(audioData);
      const now = Date.now();

      // Create a hash of the transcription to compare
      const currentHash = transcribedText ? transcribedText.trim() : '';

      logger.debug('Processing transcription:', {
        currentHash,
        lastTranscriptionHash: this.lastTranscriptionHash,
        timeSinceLastProcess: now - this.lastProcessedTime,
        messageInterval: this.messageInterval
      });

      // Skip if we've processed this exact transcription recently
      if (currentHash &&
        (currentHash !== this.lastTranscriptionHash ||
          now - this.lastProcessedTime >= this.messageInterval)) {

        logger.info('Transcription received:', transcribedText);
        this.lastTranscriptionHash = currentHash;
        this.lastProcessedTime = now;

        // Only emit transcription event if it's different from the last one and enough time has passed
        if (transcribedText !== this.lastEmittedTranscription &&
          now - this.lastEmittedTime >= this.messageInterval) {
          logger.info('Emitting transcription event');
          this.emit('transcription', transcribedText);
          this.lastEmittedTranscription = transcribedText;
          this.lastEmittedTime = now;

          // Generate and emit message
          const message = await this.generateMessage(JSON.stringify({
            lastTranscription: transcribedText,
            isStreamerMessage: true
          }));

          if (message && message.trim() !== '') {
            logger.info('Generated message:', message);
            this.emit('message', message);
          }
        }

        logger.info('Processing complete');
      } else {
        logger.info('Skipping duplicate transcription');
      }
    } catch (error) {
      logger.error('Error processing audio chunk:', error);
    } finally {
      // Always clean up the temporary file
      try {
        if (this.tempAudioFile && existsSync(this.tempAudioFile)) {
          unlinkSync(this.tempAudioFile);
        }
      } catch (error) {
        logger.error('Error cleaning up temporary file:', error);
      }
      this.tempAudioFile = null;
      this.isProcessing = false;
      this.processingLock = false;
    }
  }

  private readAudioFile(filePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      fs.readFile(filePath, (err: Error | null, data: Buffer) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
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
        throw new Error('Groq client not initialized. Please set GROQ_API_KEY in environment variables.');
      }

      const response = await this.groq.audio.transcriptions.create({
        file: fs.createReadStream(tempFile),
        model: "whisper-large-v3-turbo",
        language: language,
        response_format: "text"
      });

      // Clean up the temporary file
      fs.unlinkSync(tempFile);

      if (!response || typeof response !== 'string') {
        throw new Error('Invalid transcription response from Groq');
      }

      return response;
    } catch (error) {
      logger.error('Error processing audio to text with Groq:', error);
      throw error;
    }
  }

  public async generateMessage(context?: string): Promise<string> {
    try {
      // If no channel info is available yet, don't generate a message
      if (!this.currentChannelInfo) {
        logger.warn('No channel info available for message generation');
        return '';
      }

      let parsedContext: any = {};
      try {
        if (context) {
          parsedContext = JSON.parse(context);
        }
      } catch (error) {
        logger.error('Error parsing context:', error);
        parsedContext = { rawText: context };
      }

      // Don't generate messages without transcription context
      if (!parsedContext.lastTranscription && !parsedContext.chatMessage) {
        logger.info('Transcription is being generated and will be available soon');
        return '';
      }

      // Don't generate messages if the transcription is too short
      if (parsedContext.lastTranscription && parsedContext.lastTranscription.length < 10) {
        logger.warn('Transcription too short for message generation');
        return '';
      }

      const channelContext = `
        Channel Title: ${this.currentChannelInfo.title}
        Game: ${this.currentChannelInfo.gameName}
        Viewers: ${this.currentChannelInfo.viewerCount}
        Description: ${this.currentChannelInfo.description}
        Language: ${process.env.ORIGINAL_STREAM_LANGUAGE || 'en'}
      `;

      const lastTranscription = parsedContext.lastTranscription ? `
        The streamer just said: "${parsedContext.lastTranscription}"
      ` : '';

      const chatContext = parsedContext.chatMessage ? `
        A viewer just said: "${parsedContext.chatMessage}"
      ` : '';

      const timeContext = parsedContext.timeSinceLastMessage ? `
        Time since last message: ${Math.floor(parsedContext.timeSinceLastMessage / 1000)} seconds
      ` : '';

      const messageCountContext = parsedContext.messageCount ? `
        Total messages sent: ${parsedContext.messageCount}
      ` : '';

      const prompt = `
        You are a Twitch viewer watching this stream. Generate a natural, engaging message that a real viewer would type in chat.
        
        Stream Context:
        ${channelContext}
        
        ${lastTranscription}
        ${chatContext}
        ${timeContext}
        ${messageCountContext}
        
        Guidelines:
        - Write as if you're a real viewer enjoying the stream
        - Keep messages short and casual (max 50 characters)
        - Use emojis in only 20% of messages, and when used, keep them natural and relevant
        - Focus on the current game being played (${this.currentChannelInfo.gameName})
        - If there's a transcription available, respond naturally to what the streamer said
        - If there's a chat message, respond to it naturally
        - Write in the stream's language (${process.env.ORIGINAL_STREAM_LANGUAGE || 'en'})
        - Don't mention that you're a bot or AI
        - Don't use excessive emojis or caps
        - Don't spam or use repetitive messages
        - Don't use commands or special characters
        - Keep it natural and conversational
        - Consider the time since the last message and message count to vary your responses
        - IMPORTANT: Do NOT repeat what the streamer said. Instead, respond naturally to it.
        - IMPORTANT: Generate JUST the chat message, not any other text or comments.
        
        Message Types (choose based on context):
        1. Game-related comments:
           - Comment on gameplay moments
           - Ask about game mechanics
           - Share tips or strategies
           - React to in-game events
        
        2. Stream interaction:
           - Respond to streamer's commentary
           - Ask relevant questions about the game
           - Share your thoughts on the streamer's playstyle
           - React to streamer's reactions
        
        3. General engagement:
           - Welcome new viewers
           - React to streamer's jokes or stories
           - Share your excitement about the stream
           - Ask about streamer's plans or goals
        
        If there's not enough context to generate a specific message, ask general questions about:
        - The current game being played
        - The streamer's experience with the game
        - Favorite strategies or playstyles
        - Upcoming content or plans
        - Community events or tournaments
      `;

      logger.info('Generating message with context:', {
        channel: this.currentChannelInfo.title,
        game: this.currentChannelInfo.gameName,
        transcription: parsedContext.lastTranscription,
        isStreamerMessage: parsedContext.isStreamerMessage
      });

      if (!this.groq) {
        throw new Error('Groq client not initialized. Please set GROQ_API_KEY in environment variables.');
      }

      const response = await this.groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are a Twitch viewer watching a stream. Generate natural, engaging messages that a real viewer would type in chat. Never repeat what the streamer said - instead, respond naturally to it."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 50,
        temperature: 0.7
      });

      const message = response.choices[0].message?.content?.trim() || '';

      return message;
    } catch (error) {
      logger.error('Error generating message:', error);
      return '';
    }
  }

  private async getStreamUrl(channelName: string): Promise<string> {
    // Use Twitch GQL to get proper HLS token - works without streamlink
    const oauthToken = (process.env.BOT1_OAUTH_TOKEN || process.env.BOT1_OAUTH || '')
      .replace('oauth:', '');

    const gqlHeaders: Record<string, string> = {
      'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Content-Type': 'application/json',
    };
    if (oauthToken) {
      gqlHeaders['Authorization'] = `OAuth ${oauthToken}`;
    }

    try {
      const tokenResp = await axios.post('https://gql.twitch.tv/gql', {
        operationName: 'PlaybackAccessToken_Template',
        query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature __typename}videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}}`,
        variables: {
          isLive: true,
          login: channelName,
          isVod: false,
          vodID: '',
          playerType: 'site'
        }
      }, { headers: gqlHeaders });

      const tokenData = tokenResp.data?.data?.streamPlaybackAccessToken;
      if (!tokenData?.value || !tokenData?.signature) {
        throw new Error('No token in GQL response');
      }

      const url = `https://usher.ttvnw.net/api/channel/hls/${channelName}.m3u8?client_id=kimne78kx3ncx6brgo4mv6wki5h1ko&token=${encodeURIComponent(tokenData.value)}&sig=${tokenData.signature}&allow_source=true&allow_spectre=true&fast_bread=true`;
      logger.info('Got HLS URL via GQL token');
      return url;
    } catch (err: any) {
      logger.error('GQL token failed:', err?.response?.data || err?.message);
      throw err;
    }
  }
} 