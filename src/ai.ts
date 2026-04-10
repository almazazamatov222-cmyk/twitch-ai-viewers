import Groq from 'groq-sdk';

export interface PersonaConfig {
  role: string;
  sys: string;
}

export interface TranscriptEntry {
  heard: string;        // what Whisper heard
  username: string;     // which bot responded
  message: string;      // what the bot wrote
  persona: string;
  timestamp: number;
}

interface Msg { role: 'user' | 'assistant'; content: string; }

const BUILTIN: Record<string, PersonaConfig> = {
  'olegzhoskii': {
    role: 'ukrainian_teen',
    sys: `Ти — 15-річний українець-школяр, фанат стримера. ТІЛЬКИ українська мова.
Стиль: "бро", "топ", "лол", "кайф", "gg", помилки як школяр. Макс 8 слів.`,
  },
};

export class AIService {
  private groq: Groq;
  private histories = new Map<string, Msg[]>();
  private realChatSamples: string[] = [];
  private settings: Record<string, boolean>;
  private customPersonas = new Map<string, PersonaConfig>();
  public transcriptLog: TranscriptEntry[] = [];

  constructor(apiKey: string, settings: Record<string, boolean> = {}, savedPersonas?: Record<string, PersonaConfig>) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
    for (const [k, v] of Object.entries(BUILTIN)) this.customPersonas.set(k, v);
    if (savedPersonas) {
      for (const [k, v] of Object.entries(savedPersonas)) this.customPersonas.set(k.toLowerCase(), v);
    }
  }

  setPersona(username: string, cfg: PersonaConfig): void {
    this.customPersonas.set(username.toLowerCase(), cfg);
    this.histories.delete(username.toLowerCase());
  }

  getPersonas(): Record<string, PersonaConfig> {
    const out: Record<string, PersonaConfig> = {};
    for (const [k, v] of this.customPersonas) out[k] = v;
    return out;
  }

  addRealMessage(displayName: string, message: string): void {
    this.realChatSamples.push(displayName + ': ' + message);
    if (this.realChatSamples.length > 30) this.realChatSamples.shift();
  }

  /**
   * Generate a message BASED ON transcription from the stream.
   * This is the ONLY way bots should send messages.
   */
  async generateFromTranscription(
    username: string,
    transcribedText: string,
    language: string,
    botIndex = 0,
    taggedMessage?: string
  ): Promise<string> {
    const k = username.toLowerCase();
    const custom = this.customPersonas.get(k);
    const lang = custom ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');

    // Build recent real chat context for style mimicry
    const chatCtx = this.realChatSamples.length >= 3
      ? '\nRecent real viewer messages (copy their style):\n' + this.realChatSamples.slice(-8).join('\n')
      : '';

    let system: string;
    let userPrompt: string;

    if (taggedMessage) {
      system = custom
        ? custom.sys + '\nOutput ONLY the reply. Max 15 words.'
        : `You are a Twitch viewer. Write in ${lang}. Max 2 sentences.`;
      userPrompt = `Someone tagged you: "${taggedMessage}". Reply naturally.`;
    } else {
      system = [
        custom
          ? custom.sys
          : `You are "${username}", a real Twitch chat viewer. Write in ${lang} only.`,
        '',
        `The streamer just said (transcribed from audio): "${transcribedText}"`,
        chatCtx,
        '',
        'Write ONE short chat message reacting to what the streamer JUST SAID.',
        'Your reaction must be directly about what was transcribed.',
        'Match the style and length of the real viewer messages above.',
        'Output ONLY the chat message. No quotes. No username prefix. Max 15 words.',
        'Sound like a real human viewer.',
      ].filter(Boolean).join('\n');
      userPrompt = 'React to what the streamer just said.';
    }

    const history = this.histories.get(k) || [];

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 60,
        temperature: 0.88,
        frequency_penalty: 1.2,
        presence_penalty: 0.8,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user' as const, content: userPrompt },
        ],
      });

      const raw = (res.choices[0]?.message?.content || '').trim()
        .replace(/^["'`*_]+|["'`*_]+$/g, '')
        .replace(/^\w+:\s*/, '')
        .trim();

      if (!raw || raw.length < 2) return this.fallback(language, !!custom);

      const updated: Msg[] = [
        ...history,
        { role: 'user' as const, content: userPrompt },
        { role: 'assistant' as const, content: raw },
      ].slice(-6);
      this.histories.set(k, updated);

      this.transcriptLog.push({
        heard: taggedMessage ? '[@tag]' : transcribedText,
        username,
        message: raw,
        persona: custom ? custom.role : 'default_' + botIndex,
        timestamp: Date.now(),
      });
      if (this.transcriptLog.length > 300) this.transcriptLog.shift();

      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return '';
    }
  }

  private fallback(lang: string, isUkr = false): string {
    if (isUkr) return '';  // Ukrainian bot stays quiet on fallback
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', '🔥', 'норм'],
      en: ['gg', 'lol', 'nice', 'Pog', 'GG'],
      kk: ['жарайсың', 'gg', 'алға'],
    };
    return (f[lang] || f.en)[Math.floor(Math.random() * 6)];
  }
}
