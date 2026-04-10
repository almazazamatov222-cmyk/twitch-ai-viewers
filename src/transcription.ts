import { exec } from 'child_process';
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
  private chunkDuration = 30; // seconds of audio per chunk

  constructor(groqKey: string, channel: string) {
    this.groq = new Groq({ apiKey: groqKey });
    this.channel = channel;
    this.tmpDir = os.tmpdir();
  }

  start(onTranscript: (result: TranscriptResult) => void): void {
    this.stopped = false;
    this.scheduleCapture(onTranscript);
  }

  private scheduleCapture(onTranscript: (result: TranscriptResult) => void): void {
    if (this.stopped) return;
    // Run capture immediately, then every chunkDuration seconds
    this.captureAndTranscribe(onTranscript).finally(() => {
      if (!this.stopped) {
        this.timer = setTimeout(
          () => this.scheduleCapture(onTranscript),
          this.chunkDuration * 1000
        );
      }
    });
  }

  private async captureAndTranscribe(onTranscript: (result: TranscriptResult) => void): Promise<void> {
    const audioFile = path.join(this.tmpDir, `twitchboost_${Date.now()}.mp3`);
    try {
      // Get stream HLS URL via streamlink, pipe audio to ffmpeg
      const streamUrl = `https://twitch.tv/${this.channel}`;
      await this.captureAudio(streamUrl, audioFile);

      if (!fs.existsSync(audioFile)) {
        console.log('[transcription] No audio file (stream offline?)');
        return;
      }

      const stat = fs.statSync(audioFile);
      if (stat.size < 10000) {
        console.log('[transcription] Audio file too small, skipping');
        return;
      }

      console.log('[transcription] Sending to Whisper...');
      const transcription = await this.groq.audio.transcriptions.create({
        file: fs.createReadStream(audioFile) as any,
        model: 'whisper-large-v3',
        response_format: 'text',
      });

      const text = typeof transcription === 'string'
        ? transcription.trim()
        : (transcription as any).text?.trim() || '';

      if (text && text.length > 5) {
        console.log('[transcription] Heard:', text.slice(0, 100));
        onTranscript({ text, timestamp: Date.now() });
      }
    } catch (e: any) {
      console.error('[transcription] Error:', e.message);
    } finally {
      try { if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile); } catch { /* ignore */ }
    }
  }

  private captureAudio(streamUrl: string, outputFile: string): Promise<void> {
    return new Promise((resolve) => {
      // Use streamlink to get best audio quality stream, pipe to ffmpeg for audio extraction
      const cmd = [
        `streamlink --quiet "${streamUrl}" best --stdout`,
        `ffmpeg -i pipe:0 -t ${this.chunkDuration} -vn -ar 16000 -ac 1 -f mp3 "${outputFile}" -y 2>/dev/null`,
      ].join(' | ');

      const proc = exec(cmd, { timeout: (this.chunkDuration + 15) * 1000 }, (err) => {
        if (err && err.code !== null && err.signal !== 'SIGTERM') {
          // Try alternative: direct ffmpeg from HLS
          this.captureAudioFallback(streamUrl, outputFile).then(resolve).catch(() => resolve());
        } else {
          resolve();
        }
      });

      // Kill after duration + buffer
      setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, (this.chunkDuration + 10) * 1000);
    });
  }

  private async captureAudioFallback(streamUrl: string, outputFile: string): Promise<void> {
    // Fallback: try to get M3U8 URL from streamlink and feed directly to ffmpeg
    return new Promise((resolve) => {
      exec(
        `streamlink --quiet "${streamUrl}" best --stream-url`,
        { timeout: 10000 },
        (err, stdout) => {
          if (err || !stdout.trim()) { resolve(); return; }
          const m3u8 = stdout.trim();
          const cmd = `ffmpeg -i "${m3u8}" -t ${this.chunkDuration} -vn -ar 16000 -ac 1 -f mp3 "${outputFile}" -y 2>/dev/null`;
          exec(cmd, { timeout: (this.chunkDuration + 10) * 1000 }, () => resolve());
        }
      );
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
