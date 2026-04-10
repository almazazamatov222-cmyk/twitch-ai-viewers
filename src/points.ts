import WebSocket from 'ws';

export interface PointsEvent {
  username: string;
  balance: number;
  gained: number;
  type: string;
}

type EmitFn = (event: string, data: unknown) => void;

export class ChannelPointsService {
  private connections = new Map<string, { ws: WebSocket; token: string; userId: string }>();
  private channel: string;
  private channelId: string;
  private clientId: string;
  private emit: EmitFn;
  private stopped = false;

  constructor(channel: string, channelId: string, clientId: string, emit: EmitFn) {
    this.channel = channel;
    this.channelId = channelId;
    this.clientId = clientId;
    this.emit = emit;
  }

  async connectBot(username: string, token: string): Promise<void> {
    if (this.stopped) return;
    const cleanToken = token.replace(/^oauth:/i, '');

    // Get bot user ID via validation
    let userId = '';
    try {
      const { default: axios } = await import('axios');
      const res = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: 'OAuth ' + cleanToken },
        timeout: 5000,
      });
      userId = res.data.user_id;
      if (!userId) { console.warn('[points]', username, 'no user_id from token'); return; }
    } catch (e: any) {
      console.warn('[points]', username, 'validate error:', e.message);
      return;
    }

    this.startPubSub(username, cleanToken, userId);
  }

  private startPubSub(username: string, token: string, userId: string): void {
    if (this.stopped) return;

    const ws = new WebSocket('wss://pubsub-edge.twitch.tv/v1');
    this.connections.set(username, { ws, token, userId });

    ws.on('open', () => {
      console.log('[points]', username, 'PubSub connected');

      // Subscribe to channel points for this user on this channel
      const topics = [
        `community-points-channel-v1.${this.channelId}`,
        `community-points-user-v1.${userId}`,
      ];

      ws.send(JSON.stringify({
        type: 'LISTEN',
        nonce: username + '_' + Date.now(),
        data: {
          topics,
          auth_token: token,
        },
      }));

      // Ping every 4 minutes to keep alive
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PING' }));
        } else {
          clearInterval(pingInterval);
        }
      }, 240000);
    });

    ws.on('message', (raw: Buffer) => {
      if (this.stopped) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'MESSAGE') {
          const data = JSON.parse(msg.data?.message || '{}');
          this.handlePointsEvent(username, token, userId, data);
        } else if (msg.type === 'RESPONSE' && msg.error) {
          console.warn('[points]', username, 'LISTEN error:', msg.error);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('close', () => {
      if (!this.stopped) {
        console.log('[points]', username, 'reconnecting in 10s...');
        setTimeout(() => this.startPubSub(username, token, userId), 10000);
      }
    });

    ws.on('error', (e: Error) => {
      console.warn('[points]', username, 'WS error:', e.message);
    });
  }

  private async handlePointsEvent(username: string, token: string, userId: string, data: any): Promise<void> {
    const type = data.type;

    // Auto-claim bonus chest (appears every ~15 min)
    if (type === 'community-point-reward-channel-subscription-gift-received' ||
        type === 'reward-redeemed') {
      // Just log for now
      const balance = data.data?.balance?.balance;
      if (balance != null) {
        console.log('[points]', username, 'balance:', balance);
        this.emit('points:balance', { username, balance });
      }
    }

    // Claim bonus chest when it appears
    if (type === 'community-moments-channel-v1' || data.type?.includes('claim')) {
      const claimId = data.data?.claim?.id;
      if (claimId) {
        await this.claimBonusChest(username, token, userId, claimId);
      }
    }

    // Channel points balance update
    if (data.type === 'points-earned' || data.balance) {
      const balance = data.balance?.balance || data.data?.balance?.balance;
      if (balance != null) {
        this.emit('points:balance', { username, balance, gained: data.gained });
      }
    }
  }

  async claimBonusChest(username: string, token: string, userId: string, claimId?: string): Promise<void> {
    try {
      const { default: axios } = await import('axios');

      // Use GQL mutation to claim
      const mutation = claimId ? [{
        operationName: 'ClaimCommunityPoints',
        variables: { input: { channelID: this.channelId, claimID: claimId } },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
          },
        },
      }] : [{
        operationName: 'JoinCommunityPoints',
        variables: { channelID: this.channelId },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '9ca1e3641c4fc39a1e8b5fa02aa0f7c72e9d55aae23f42e08b26a50d5aef47d0',
          },
        },
      }];

      await axios.post('https://gql.twitch.tv/gql', mutation, {
        headers: {
          'Authorization': 'OAuth ' + token,
          'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      console.log('[points]', username, '✓ claimed bonus chest');
      this.emit('points:claimed', { username });
    } catch (e: any) {
      console.warn('[points]', username, 'claim error:', e.message);
    }
  }

  // Get current points balance for a bot
  async getBalance(username: string, token: string, channelId: string): Promise<number | null> {
    try {
      const { default: axios } = await import('axios');
      const res = await axios.post('https://gql.twitch.tv/gql', [{
        operationName: 'ChannelPointsContext',
        variables: { channelLogin: this.channel, includeGoalTypes: ['CREATOR', 'BOOST'] },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '9988086801c220a9bb3d9e3e6cd64ed5bcc9cb3c51d5d47b1bfb432fa7cd6c86',
          },
        },
      }], {
        headers: {
          'Authorization': 'OAuth ' + token,
          'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });
      const balance = res.data?.[0]?.data?.community?.channel?.self?.communityPoints?.balance;
      return balance ?? null;
    } catch { return null; }
  }

  stop(): void {
    this.stopped = true;
    for (const { ws } of this.connections.values()) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}
