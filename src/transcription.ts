import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Groq from 'groq-sdk';

export interface TranscriptResult {
  text: string;
  timestamp: number;
}

export class TranscriptionService {
  private groq: Groq;
  private channel: string;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private tmpDir: string;
  private chunkDuration = 25;
  private offlineRetryMs = 45000;
  private onlineRetryMs = 18000;

  constructor(groqKey: string, channel: string) {
    this.groq = new Groq({ apiKey: groqKey });
    this.channel = channel;
    this.tmpDir = os.tmpdir();
    this.checkDeps();
  }

  private checkDeps(): void {
    exec('which streamlink || streamlink --version', (err, stdout) => {
      if (err) {
        console.error('[transcription] streamlink NOT FOUND:', err.message);
        console.log('[transcription] Trying: pip3 install streamlink --break-system-packages');
        exec('pip3 install streamlink --break-system-packages 2>&1', (_e, out) => {
          console.log('[transcription] pip install result:', out?.slice(0, 200));
        });
      } else {
        console.log('[transcription] streamlink found:', stdout?.trim() || 'ok');
      }
    });
    exec('which ffmpeg || ffmpeg -version 2>&1 | head -1', (err, stdout) => {
      if (err) console.error('[transcription] ffmpeg NOT FOUND');
      else console.log('[transcription] ffmpeg found:', stdout?.trim()?.slice(0, 60) || 'ok');
    });
  }

  start(onTranscript: (result: TranscriptResult) => void): void {
    this.stopped = false;
    console.log('[transcription] Starting for channel:', this.channel);
    this.scheduleCapture(onTranscript);
  }

  private scheduleCapture(onTranscript: (result: TranscriptResult) => void): void {
    if (this.stopped) return;
    this.captureAndTranscribe(onTranscript).then(wasOnline => {
      if (!this.stopped) {
        const delay = wasOnline ? this.onlineRetryMs : this.offlineRetryMs;
        this.timer = setTimeout(() => this.scheduleCapture(onTranscript), delay);
      }
    }).catch(err => {
      console.error('[transcription] Unhandled error:', err);
      if (!this.stopped) {
        this.timer = setTimeout(() => this.scheduleCapture(onTranscript), this.offlineRetryMs);
      }
    });
  }

  private async captureAndTranscribe(onTranscript: (result: TranscriptResult) => void): Promise<boolean> {
    const audioFile = path.join(this.tmpDir, `twitchboost_${Date.now()}.mp3`);
    try {
      const success = await this.captureAudio(audioFile);
      if (!success) return false;

      if (!fs.existsSync(audioFile)) {
        console.log('[transcription] Audio file missing after capture');
        return false;
      }

      const stat = fs.statSync(audioFile);
      console.log('[transcription] Audio file size:', stat.size, 'bytes');

      if (stat.size < 8000) {
        console.log('[transcription] Audio too small, stream likely offline');
        return false;
      }

      console.log('[transcription] Sending to Groq Whisper...');
      const transcription = await this.groq.audio.transcriptions.create({
        file: fs.createReadStream(audioFile) as any,
        model: 'whisper-large-v3',
        response_format: 'text',
      });

      const text = (typeof transcription === 'string' ? transcription : (transcription as any).text || '').trim();

      if (text && text.length > 3) {
        console.log('[transcription] ✓ Heard:', text.slice(0, 120));
        onTranscript({ text, timestamp: Date.now() });
        return true;
      } else {
        console.log('[transcription] Empty transcription result');
        return true;
      }
    } catch (e: any) {
      console.error('[transcription] Error:', e.message);
      return false;
    } finally {
      try { if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile); } catch { /* ignore */ }
    }
  }

  private captureAudio(outputFile: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Find streamlink in nix store
      const { execSync } = require('child_process');
      let streamlinkPath = 'streamlink';
      try {
        const path = execSync('which streamlink 2>/dev/null || find /nix/store -name streamlink -type f 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
        if (path && !path.includes('which')) {
          streamlinkPath = path;
          console.log('[transcription] Found streamlink:', streamlinkPath);
        }
      } catch {}
      const streamUrl = `https://twitch.tv/${this.channel}`;
      console.log('[transcription] Capturing audio from', streamUrl, 'for', this.chunkDuration, 's...');

      const streamlink = spawn(streamlinkPath, [
        '--quiet',
        '--twitch-low-latency',
        streamUrl,
        'audio_only,worst',
        '--stdout',
      ], { timeout: (this.chunkDuration + 15) * 1000 });

      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-t', String(this.chunkDuration),
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'mp3',
        outputFile,
        '-y',
      ]);

      let streamlinkErr = '';
      let streamlinkDone = false;
      let ffmpegDone = false;
      let timedOut = false;

      streamlink.stdout.pipe(ffmpeg.stdin);

      streamlink.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        streamlinkErr += s;
        if (s.includes('error') || s.includes('Error') || s.includes('offline') || s.includes('No playable')) {
          console.log('[streamlink]', s.trim().slice(0, 200));
        }
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        console.log('[transcription] Capture timeout — killing processes');
        try { streamlink.kill('SIGTERM'); } catch { /* ignore */ }
        try { ffmpeg.stdin.end(); ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
      }, (this.chunkDuration + 12) * 1000);

      const check = () => {
        if (streamlinkDone && ffmpegDone) {
          clearTimeout(timeout);
          const isOffline = streamlinkErr.includes('No playable streams') ||
                            streamlinkErr.includes('No streams') ||
                            streamlinkErr.includes('offline') ||
                            streamlinkErr.includes('does not exist');
          if (isOffline) {
            console.log('[transcription] Stream is offline');
            resolve(false);
          } else if (timedOut) {
            resolve(true);
          } else {
            resolve(true);
          }
        }
      };

      streamlink.on('close', (code) => {
        streamlinkDone = true;
        if (code !== 0 && code !== null && !timedOut) {
          console.log('[streamlink] exited with code', code);
          if (streamlinkErr.length > 0) {
            console.log('[streamlink] stderr:', streamlinkErr.slice(0, 300));
          }
        }
        try { ffmpeg.stdin.end(); } catch { /* ignore */ }
        check();
      });

      ffmpeg.on('close', (code) => {
        ffmpegDone = true;
        if (code !== 0 && code !== null && !timedOut) {
          console.log('[ffmpeg] exited with code', code);
        }
        check();
      });

      streamlink.on('error', (e) => {
        console.error('[streamlink] spawn error:', e.message);
        streamlinkDone = true;
        try { ffmpeg.stdin.end(); } catch { /* ignore */ }
        check();
      });

      ffmpeg.on('error', (e) => {
        console.error('[ffmpeg] spawn error:', e.message);
        ffmpegDone = true;
        check();
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}