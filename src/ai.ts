import Groq from 'groq-sdk';

interface BotPersona {
  name: string;
  style: string;
  traits: string[];
  chatHistory: { role: 'user' | 'assistant'; content: string }[];
}

const PERSONAS = [
  {
    style: 'enthusiastic fan',
    traits: ['Very hyped', 'Uses lots of exclamations', 'Loves the streamer', 'Short excited messages'],
  },
  {
    style: 'chill lurker',
    traits: ['Relaxed', 'Occasional short comments', 'Uses "lol" and "lmao"', 'Laid back vibe'],
  },
  {
    style: 'helpful viewer',
    traits: ['Gives tips and advice', 'Asks strategic questions', 'Knows the game well', 'Constructive'],
  },
  {
    style: 'funny troll (friendly)',
    traits: ['Makes jokes', 'Light-hearted trolling', 'Puns and wordplay', 'Never mean'],
  },
  {
    style: 'newbie curious',
    traits: ['Asks questions about the game', 'Learning', 'Impressed by things', 'Innocent reactions'],
  },
  {
    style: 'veteran gamer',
    traits: ['References old games', 'Technical knowledge', 'Nostalgic', 'Matter-of-fact comments'],
  },
  {
    style: 'hype man',
    traits: ['PogChamp energy', 'Hypes up plays', 'CAPS sometimes', 'Very reactive'],
  },
  {
    style: 'calm analyst',
    traits: ['Strategic observations', 'Thoughtful', 'Brief insights', 'Respectful'],
  },
];

const EMOJI_SETS = {
  hype: ['PogChamp', 'POGGERS', 'Pog', '🔥', '💯', 'LUL', '😂', '😮', 'OMEGALUL', 'PauseChamp'],
  positive: ['✨', '👍', '💪', '🎮', '🏆', '❤️', 'Clap', 'GG', 'NotLikeThis'],
  neutral: ['👀', '🤔', 'Hmm', 'monkaS', 'KEKW', '😅', '😭', 'copium'],
};

export class AIService {
  private groq: Groq;
  private botPersonas: Map<string, BotPersona> = new Map();
  private settings: any;
  private recentMessages: string[] = [];

  constructor(apiKey: string, settings: any = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
  }

  assignPersona(username: string): void {
    if (this.botPersonas.has(username)) return;
    const idx = this.botPersonas.size % PERSONAS.length;
    const persona = PERSONAS[idx];
    this.botPersonas.set(username, {
      name: username,
      style: persona.style,
      traits: persona.traits,
      chatHistory: [],
    });
  }

  addChatContext(message: string): void {
    this.recentMessages.push(message);
    if (this.recentMessages.length > 20) this.recentMessages.shift();
  }

  async generateMessage(
    username: string,
    streamContext: string,
    language: string,
    transcript?: string
  ): Promise<string> {
    this.assignPersona(username);
    const persona = this.botPersonas.get(username)!;

    const langName = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
    const emojiInstruction = this.settings.useEmoji
      ? 'You may occasionally use Twitch emotes like LUL, PogChamp, Kappa, KEKW, or relevant emojis.'
      : 'Do not use emojis or emotes.';

    const chatCtx = this.settings.chatContext && this.recentMessages.length > 0
      ? `\nRecent chat messages:\n${this.recentMessages.slice(-5).join('\n')}\n`
      : '';

    const transcriptCtx = transcript
      ? `\nStreamer just said: "${transcript}"\n`
      : '';

    const systemPrompt = this.settings.uniquePersonas
      ? `You are a Twitch viewer named "${username}" watching a live stream.
Your personality: ${persona.style}
Your traits: ${persona.traits.join(', ')}
You write in ${langName}.
Keep messages SHORT (5-25 words maximum). Be natural and conversational.
Never repeat yourself. Never say generic things like "nice stream" every time.
${emojiInstruction}
Stream context: ${streamContext || 'Gaming stream'}
${chatCtx}${transcriptCtx}
Generate ONE unique chat message that fits your personality. Just the message, nothing else.`
      : `You are a Twitch chat viewer named "${username}".
You write in ${langName}.
Keep messages SHORT (5-25 words). Be natural, varied, and engaging.
${emojiInstruction}
Stream context: ${streamContext || 'Gaming stream'}
${chatCtx}${transcriptCtx}
Generate ONE unique chat message. Just the message, nothing else.`;

    // Use chat history for continuity
    const messages = [
      ...persona.chatHistory.slice(-6),
      {
        role: 'user' as const,
        content: 'Generate a chat message now.',
      },
    ];

    try {
      const response = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 80,
        temperature: 0.9,
        top_p: 0.95,
        frequency_penalty: 0.8,
        presence_penalty: 0.6,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
      });

      const msg = response.choices[0]?.message?.content?.trim() || '';

      // Update history
      persona.chatHistory.push(
        { role: 'user', content: 'Generate a chat message now.' },
        { role: 'assistant', content: msg }
      );
      if (persona.chatHistory.length > 12) {
        persona.chatHistory = persona.chatHistory.slice(-12);
      }

      return this.sanitizeMessage(msg);
    } catch (err: any) {
      console.error(`[AI] Error for ${username}:`, err.message);
      return this.fallbackMessage(language, persona.style);
    }
  }

  private sanitizeMessage(msg: string): string {
    // Remove quotes if wrapped
    return msg.replace(/^["']|["']$/g, '').trim().slice(0, 200);
  }

  private fallbackMessage(language: string, style: string): string {
    const fallbacks: Record<string, string[]> = {
      ru: ['это было круто!', 'gg!', 'давай давай!', 'чат, вы видели это?', '😮 вот это да', 'лол', 'удачи!'],
      en: ['let\'s go!', 'nice one!', 'gg!', 'hype!', 'lol that was close', 'GG', 'PogChamp'],
      kk: ['жарайсың!', 'gg!', 'алға!', 'осыны көрдіңдер ме?'],
    };
    const arr = fallbacks[language] || fallbacks.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  clearHistory(username: string): void {
    const persona = this.botPersonas.get(username);
    if (persona) persona.chatHistory = [];
  }
}
