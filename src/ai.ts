import Groq from 'groq-sdk';

const PERSONAS = [
  { style: 'enthusiastic fan', traits: 'Very hyped, short excited messages, uses exclamations' },
  { style: 'chill viewer', traits: 'Relaxed, casual, uses lol/lmao, laid back' },
  { style: 'helpful viewer', traits: 'Gives tips, asks strategic questions, knowledgeable' },
  { style: 'funny troll', traits: 'Makes jokes, light-hearted, puns, never mean' },
  { style: 'newbie', traits: 'Asks questions, curious, impressed, innocent reactions' },
  { style: 'veteran gamer', traits: 'References old games, technical, nostalgic' },
  { style: 'hype man', traits: 'PogChamp energy, hypes up plays, reactive' },
  { style: 'analyst', traits: 'Strategic observations, thoughtful, brief insights' },
];

interface ChatHistory {
  role: 'user' | 'assistant';
  content: string;
}

export class AIService {
  private groq: Groq;
  private personas = new Map<string, (typeof PERSONAS)[0]>();
  private histories = new Map<string, ChatHistory[]>();
  private recentChat: string[] = [];
  private settings: Record<string, boolean>;

  constructor(apiKey: string, settings: Record<string, boolean> = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
  }

  addChatContext(line: string): void {
    this.recentChat.push(line);
    if (this.recentChat.length > 15) this.recentChat.shift();
  }

  private getPersona(username: string) {
    if (!this.personas.has(username)) {
      const idx = this.personas.size % PERSONAS.length;
      this.personas.set(username, PERSONAS[idx]);
    }
    return this.personas.get(username)!;
  }

  async generateMessage(
    username: string,
    context: string,
    language: string
  ): Promise<string> {
    const persona = this.getPersona(username);
    const langName = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
    const emojiHint = this.settings.useEmoji
      ? 'May use Twitch emotes like LUL, Pog, KEKW, or relevant emojis occasionally.'
      : 'Do not use emojis.';
    const chatCtx = this.settings.chatContext && this.recentChat.length
      ? '\nRecent chat:\n' + this.recentChat.slice(-5).join('\n')
      : '';

    const system = `You are a Twitch viewer "${username}" watching a live stream.
Personality: ${persona.style}. Traits: ${persona.traits}.
Language: ${langName}. Be SHORT (5-20 words max). Natural and varied.
${emojiHint}
Stream context: ${context || 'Gaming stream'}${chatCtx}
Generate ONE unique chat message. Output ONLY the message, nothing else.`;

    const history = this.histories.get(username) || [];

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 60,
        temperature: 0.92,
        frequency_penalty: 0.85,
        presence_penalty: 0.6,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-8),
          { role: 'user', content: 'Send a chat message now.' },
        ],
      });

      const msg = res.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') || '';
      
      // Update history
      const newHistory: ChatHistory[] = [
        ...history,
        { role: 'user', content: 'Send a chat message now.' },
        { role: 'assistant', content: msg },
      ].slice(-10);
      this.histories.set(username, newHistory);

      return msg.slice(0, 200);
    } catch (err: any) {
      console.error(`[AI] ${username}: ${err.message}`);
      const fallbacks: Record<string, string[]> = {
        ru: ['nice!', 'gg!', 'давай!', 'лол', '😮', 'хорошо сыграно'],
        en: ['nice!', 'gg!', 'let\'s go!', 'lol', 'PogChamp'],
        kk: ['жарайсың!', 'gg!', 'алға!'],
      };
      const arr = fallbacks[language] || fallbacks.en;
      return arr[Math.floor(Math.random() * arr.length)];
    }
  }
}
