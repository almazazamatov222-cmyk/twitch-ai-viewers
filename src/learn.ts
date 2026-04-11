import * as tmi from 'tmi.js';
import * as fs from 'fs';
import * as path from 'path';

interface MarkovChain {
  [key: string]: string[];
}

export class LearnBot {
  private client: tmi.Client | null = null;
  private chain: MarkovChain = {};
  private starts: string[] = [];
  private keyLength = 2;
  private messages = 0;
  private words = 0;
  private running = false;
  private emit: (event: string, data: any) => void;

  constructor(emit: (event: string, data: any) => void) {
    this.emit = emit;
  }

  async start(channel: string, token: string): Promise<void> {
    if (this.running) return;
    
    const chan = channel.toLowerCase().replace(/^#/, '');
    this.client = tmi.client({
      channels: [chan],
      identity: {
        username: chan,
        password: token,
      },
      options: {
        debug: false,
      },
    });

    this.client.on('message', (chan, tags, msg, self) => {
      if (self) return;
      this.learn(msg);
      this.messages++;
      this.emit('learn:status', {
        running: this.running,
        messages: this.messages,
        words: this.words,
      });
      if (this.messages % 100 === 0) {
        this.emit('learn:log', `Изучено ${this.messages} сообщений`);
      }
    });

    this.client.on('connected', () => {
      this.running = true;
      this.emit('learn:log', `Подключено к #${chan}`);
      this.emit('learn:status', {
        running: true,
        messages: this.messages,
        words: this.words,
      });
    });

    this.client.connect();
  }

  stop(): void {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.running = false;
    this.emit('learn:log', 'Обучение остановлено');
    this.emit('learn:status', {
      running: false,
      messages: this.messages,
      words: this.words,
    });
  }

  private learn(text: string): void {
    const words = text.trim().split(/\s+/).filter(w => w.length > 0 && !w.startsWith('http'));
    if (words.length < 2) return;

    this.words += words.length;

    for (let i = 0; i <= words.length - this.keyLength; i++) {
      const key = words.slice(i, i + this.keyLength).join(' ');
      const next = words[i + this.keyLength];

      if (i === 0) {
        this.starts.push(key);
      }

      if (!this.chain[key]) {
        this.chain[key] = [];
      }
      this.chain[key].push(next);
    }
  }

  generate(start?: string): string {
    if (Object.keys(this.chain).length === 0) return '';

    let current = start || this.starts[Math.floor(Math.random() * this.starts.length)];
    const result = current.split(' ');

    for (let i = 0; i < 20; i++) {
      const options = this.chain[current];
      if (!options || options.length === 0) break;

      const next = options[Math.floor(Math.random() * options.length)];
      result.push(next);
      current = result.slice(-this.keyLength).join(' ');
    }

    return result.join(' ');
  }

  saveToFile(filepath: string): void {
    const data = {
      chain: this.chain,
      starts: this.starts,
      messages: this.messages,
      words: this.words,
    };
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    this.emit('learn:log', `Сохранено в ${filepath}`);
  }

  getStats() {
    return {
      messages: this.messages,
      words: this.words,
      running: this.running,
    };
  }
}