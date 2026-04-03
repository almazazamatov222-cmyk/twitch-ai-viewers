import axios from 'axios';
import { logger } from './logger';

// Fetches HLS segments periodically to count as a Twitch viewer
export class ViewerSimulator {
  private channelName: string;
  private botOauth: string;
  private isRunning: boolean = false;
  private playlistUrl: string | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(channelName: string, botOauth: string) {
    this.channelName = channelName;
    this.botOauth = botOauth.replace('oauth:', '');
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info(`ViewerSim: starting for ${this.channelName}`);

    try {
      await this.getPlaylistUrl();
      // Fetch segments every 4 seconds (standard HLS segment duration)
      this.interval = setInterval(() => this.fetchSegment(), 4000);
    } catch (e) {
      logger.warn('ViewerSim: could not start:', e);
      this.isRunning = false;
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.isRunning = false;
    logger.info('ViewerSim: stopped');
  }

  private async getPlaylistUrl(): Promise<void> {
    const gqlHeaders: Record<string, string> = {
      'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Content-Type': 'application/json',
    };
    if (this.botOauth) {
      gqlHeaders['Authorization'] = `OAuth ${this.botOauth}`;
    }

    const tokenResp = await axios.post('https://gql.twitch.tv/gql', {
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature __typename}videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}}`,
      variables: { isLive: true, login: this.channelName, isVod: false, vodID: '', playerType: 'site' }
    }, { headers: gqlHeaders });

    const td = tokenResp.data?.data?.streamPlaybackAccessToken;
    if (!td?.value) throw new Error('No token for viewer sim');

    // Get master playlist
    const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${this.channelName}.m3u8?client_id=kimne78kx3ncx6brgo4mv6wki5h1ko&token=${encodeURIComponent(td.value)}&sig=${td.signature}&allow_source=true`;
    const masterResp = await axios.get(masterUrl, { responseType: 'text', timeout: 10000 });

    // Pick lowest quality stream to minimize bandwidth
    const lines = masterResp.data.split('\n');
    let lowestUrl = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i+1]) {
        lowestUrl = lines[i+1].trim();
        // Don't break - keep going to get last (usually lowest) quality
      }
    }
    // Actually take first available (audio_only is smallest)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('audio_only') && lines[i+1]) {
        lowestUrl = lines[i+1].trim();
        break;
      }
    }

    if (!lowestUrl) throw new Error('No playlist URL found');
    this.playlistUrl = lowestUrl;
    logger.info('ViewerSim: got playlist URL (audio_only)');
  }

  private async fetchSegment(): Promise<void> {
    if (!this.playlistUrl || !this.isRunning) return;
    try {
      // Fetch the media playlist
      const resp = await axios.get(this.playlistUrl, {
        responseType: 'text',
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });

      // Find a segment URL and fetch it (just headers, not full body)
      const lines = resp.data.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('.ts')) {
          // Fetch just first 1KB of segment to register as viewer
          const segUrl = trimmed.startsWith('http') ? trimmed
            : new URL(trimmed, this.playlistUrl).href;
          await axios.get(segUrl, {
            responseType: 'stream',
            timeout: 5000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Range': 'bytes=0-1024'
            }
          }).then(r => r.data.destroy()).catch(() => {});
          break;
        }
      }
    } catch (e) {
      // Playlist expired — get new one
      try { await this.getPlaylistUrl(); } catch (_) {
        logger.warn('ViewerSim: lost stream, stopping');
        this.stop();
      }
    }
  }
}
