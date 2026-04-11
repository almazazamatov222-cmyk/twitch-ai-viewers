<script setup>
import { ref, reactive, onMounted, computed, h } from 'vue'
import { 
  NConfigProvider, NLayout, NLayoutSider, NLayoutContent, NMenu, 
  NButton, NInput, NList, NListItem, NThing, NAvatar, NTag, 
  NCard, NGrid, NGridItem, NSpace, NScrollbar, NBadge, NIcon,
  NSwitch, NInputNumber, NModal, NForm, NFormItem, NSelect, NAlert,
  NPopover, NTooltip, NProgress, NDivider
} from 'naive-ui'
import { 
  Chatbubbles, People, ColorPalette, Mic, Settings as SettingsIcon,
  Send, Exit, Refresh, ChevronDown, ChevronUp, Add, Trash
} from '@vicons/ionicons5'

const socket = ref(null)
const activeKey = ref('chat')
const bots = reactive({})
const chatMessages = reactive([])
const personas = reactive({})
const phrases = reactive({
  'ахахха': ['ахахха', 'KEKW', 'хахаха', 'лол'],
  'привет': ['привет!', 'здарова', 'хай!'],
  'оски': ['оски?', 'Pog', '👀'],
  'gg': ['GG', 'gg wp', 'красавчик'],
  'хайп': ["LET'S GO!", 'давай!', '🔥']
})
const botsPerTranscript = ref(2)
const totalBots = ref(0)
const presenceCount = ref(0)
const channelName = ref('')
const streamLive = ref(false)
const streamViewers = ref(0)
const streamGame = ref('')
const uptime = ref('00:00:00')
const startTime = ref(null)
const errorsList = reactive([])
const sendMode = ref('selected')
const selectedBots = reactive(new Set())
const manualMessage = ref('')
const replyingTo = ref(null)
const currentTranscript = ref('')
const transcriptHistory = reactive([])
const learning = ref(false)
const learnStats = reactive({ messages: 0, words: 0 })
const learnLogs = reactive([])

function startLearning() {
  learning.value = true
  learnStats.messages = 0
  learnStats.words = 0
  learnLogs.length = 0
  learnLogs.push('Запуск обучения...')
  socket.value.emit('learn:start')
}

function stopLearning() {
  learning.value = false
  socket.value.emit('learn:stop')
  learnLogs.push('Обучение остановлено')
}

const COLORS = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#0891b2', '#9333ea', '#c2410c']
const colorMap = new Map()
let colorIdx = 0

function getBotColor(name) {
  if (!colorMap.has(name)) colorMap.set(name, COLORS[colorIdx++ % COLORS.length])
  return colorMap.get(name)
}

const menuOptions = computed(() => [
  { label: 'Чат', key: 'chat', icon: () => h(NIcon, null, { default: () => h(Chatbubbles) }) },
  { label: 'Аккаунты', key: 'accounts', icon: () => h(NIcon, null, { default: () => h(People) }) },
  { label: 'Фразы', key: 'phrases', icon: () => h(NIcon, null, { default: () => h(ColorPalette) }) },
  { label: 'Транскрипция', key: 'transcript', icon: () => h(NIcon, null, { default: () => h(Mic) }) },
  { label: 'Обучение', key: 'learn', icon: () => h(NIcon, null, { default: () => h(SettingsIcon) }) },
])

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatUptime() {
  if (!startTime.value) return '00:00:00'
  const d = Date.now() - startTime.value
  const h = String(Math.floor(d / 3600000)).padStart(2, '0')
  const m = String(Math.floor((d % 3600000) / 60000)).padStart(2, '0')
  const s = String(Math.floor((d % 60000) / 1000)).padStart(2, '0')
  return `${h}:${m}:${s}`
}

onMounted(() => {
  const s = io()
  socket.value = s
  
  s.on('connect', () => {
    console.log('[socket] connected')
    s.emit('get:config')
    s.emit('get:personas')
    s.emit('get:phrases')
  })

  s.on('config', cfg => {
    channelName.value = cfg.channel || ''
    if (cfg.botsPerTranscript) botsPerTranscript.value = cfg.botsPerTranscript
  })

  s.on('bots:started', d => {
    totalBots.value = d.bots.length
    d.bots.forEach(u => {
      const k = u.toLowerCase()
      bots[k] = { username: u, state: 'connecting', messages: 0, selected: true }
      selectedBots.add(k)
    })
    if (!startTime.value) {
      startTime.value = Date.now()
      setInterval(() => { uptime.value = formatUptime() }, 1000)
    }
    addSystemMessage(`✅ ${d.bots.length} ботов запущено`)
  })

  s.on('bot:status', d => {
    const k = d.username.toLowerCase()
    if (bots[k]) {
      bots[k].state = d.state
      bots[k].displayState = d.message
    }
  })

  s.on('chat:message', d => {
    addChatMessage(d.username, d.message, d.isBot, d.color, d.displayName)
  })

  s.on('bot:message', d => {
    const k = d.username.toLowerCase()
    if (bots[k]) bots[k].messages = (bots[k].messages || 0) + 1
  })

  s.on('transcription:new', d => {
    currentTranscript.value = d.text
    addSystemMessage(`🎙 Услышал: ${d.text.slice(0, 80)}${d.text.length > 80 ? '...' : ''}`)
    transcriptHistory.unshift({ text: d.text, timestamp: d.timestamp, responses: [] })
    if (transcriptHistory.length > 50) transcriptHistory.pop()
  })

  s.on('transcript:entry', d => {
    const session = transcriptHistory.find(s => Math.abs(s.timestamp - d.timestamp) < 60000)
    if (session) session.responses.push({ username: d.username, message: d.message })
  })

  s.on('presence:update', data => {
    presenceCount.value = Object.values(data).filter(Boolean).length
    Object.keys(data).forEach(k => {
      if (bots[k]) bots[k].presence = data[k]
    })
  })

  s.on('presence:active', d => {
    const k = d.username.toLowerCase()
    if (bots[k]) bots[k].presence = true
  })

  s.on('stream:info', d => {
    streamLive.value = d.live
    streamGame.value = d.game || ''
    streamViewers.value = d.viewers != null ? d.viewers : 0
  })

  s.on('bot:error', d => {
    errorsList.push({ time: new Date().toTimeString().slice(0, 8), username: d.username, message: d.message })
    if (errorsList.length > 50) errorsList.shift()
  })

  s.on('personas:update', data => {
    Object.assign(personas, data || {})
  })

  s.on('phrases:update', data => {
    if (data && Object.keys(data).length) Object.assign(phrases, data)
  })
  
  s.on('learn:status', data => {
    learning.value = data.running
    learnStats.messages = data.messages
    learnStats.words = data.words
  })
  
  s.on('learn:log', msg => {
    learnLogs.unshift(msg)
    if (learnLogs.length > 50) learnLogs.pop()
  })
})

function addChatMessage(username, text, isBot, color, displayName) {
  chatMessages.push({
    username, text, isBot, color: color || getBotColor(username), 
    displayName: displayName || username, time: Date.now()
  })
  if (chatMessages.length > 300) chatMessages.shift()
}

function addSystemMessage(text) {
  chatMessages.push({ username: 'system', text, isSystem: true, time: Date.now() })
  if (chatMessages.length > 300) chatMessages.shift()
}

function sendManual() {
  if (!manualMessage.value.trim()) return
  const targets = getSelectedBots()
  if (!targets.length) return
  socket.value.emit('send:manual', { targets, message: manualMessage.value.trim() })
  manualMessage.value = ''
}

function sendPhrase(key) {
  const ph = phrases[key]
  if (!ph || !ph.length) return
  const txt = ph[Math.floor(Math.random() * ph.length)]
  const targets = getSelectedBots()
  if (!targets.length) return
  socket.value.emit('send:manual', { targets, message: txt })
}

function getSelectedBots() {
  const connected = Object.keys(bots).filter(k => bots[k].state === 'connected')
  if (!connected.length) return []
  if (sendMode.value === 'selected') {
    const selected = connected.filter(k => selectedBots.has(k))
    return selected.length ? selected : connected
  }
  if (sendMode.value === 'random') return [connected[Math.floor(Math.random() * connected.length)]]
  if (sendMode.value === 'round') {
    const idx = bots.roundIdx || 0
    bots.roundIdx = (idx + 1) % connected.length
    return [connected[idx]]
  }
  return connected
}

function toggleBotSelection(k) {
  if (selectedBots.has(k)) selectedBots.delete(k)
  else selectedBots.add(k)
}

function setBotsPerTranscript(n) {
  botsPerTranscript.value = n
  socket.value.emit('set:bots_per_transcript', { n })
}

// points disabled

const themeOverrides = {
  common: {
    primaryColor: '#7c3aed',
    primaryColorHover: '#9d5cf6',
    primaryColorPressed: '#6d28d9',
    borderRadius: '8px',
    borderRadiusSmall: '6px'
  },
  Card: {
    borderRadius: '10px'
  },
  Button: {
    borderRadiusMedium: '7px'
  }
}
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-layout class="app-layout" has-sider>
      <n-layout-sider bordered collapse-mode="width" :collapsed-width="0" :width="220" :collapsed="false" show-trigger="bar">
        <div class="logo-area">
          <div class="logo-icon">🤖</div>
          <span class="logo-text">Boostex</span>
        </div>
        <n-menu :collapsed="false" :collapsed-width="0" :collapsed-icon-size="22" :options="menuOptions" v-model:value="activeKey" />
      </n-layout-sider>
      
      <n-layout>
        <div class="top-bar">
          <div class="top-info">
            <n-tag :type="streamLive ? 'success' : 'default'" size="small">
              {{ streamLive ? 'LIVE' : 'OFFLINE' }}
            </n-tag>
            <span class="channel-name">{{ channelName || '—' }}</span>
            <span class="game-name" v-if="streamGame">· {{ streamGame }}</span>
          </div>
          <div class="top-stats">
            <span class="stat-item">👥 {{ presenceCount }}/{{ totalBots }}</span>
            <span class="stat-item">👁 {{ streamViewers.toLocaleString() }}</span>
            <span class="stat-item">⏱ {{ uptime }}</span>
            <!--points disabled-->
          </div>
        </div>

        <n-layout class="main-content" has-sider>
          <n-layout-sider bordered :width="320">
            <div class="panel-chat">
              <div class="chat-header">
                <span>Чат Twitch</span>
                <n-button-group size="tiny">
                  <n-button @click="errorsList.length = 0">Очистить</n-button>
                </n-button-group>
              </div>
              <n-scrollbar style="max-height: calc(100vh - 280px)">
                <div class="chat-messages">
                  <div v-for="(msg, idx) in chatMessages" :key="idx" 
                       class="chat-message" :class="{ system: msg.isSystem, bot: msg.isBot }">
                    <n-avatar v-if="!msg.isSystem" :size="24" :style="{ background: msg.color }">
                      {{ msg.displayName[0].toUpperCase() }}
                    </n-avatar>
                    <div class="msg-content">
                      <span class="msg-username" :style="{ color: msg.color }">{{ msg.displayName }}</span>
                      <span class="msg-text">{{ msg.text }}</span>
                    </div>
                  </div>
                  <div v-if="!chatMessages.length" class="empty-chat">
                    💬 Сообщения появятся здесь
                  </div>
                </div>
              </n-scrollbar>
              
              <div class="phrase-bar">
                <n-button v-for="(plist, key) in phrases" :key="key" size="small" @click="sendPhrase(key)">
                  {{ key }}
                </n-button>
                <n-button size="small" tertiary>+ Фраза</n-button>
              </div>
              
              <div class="chat-input">
                <n-input v-model:value="manualMessage" placeholder="Написать сообщение..." 
                         @keydown.enter="sendManual" />
                <n-button type="primary" @click="sendManual">
                  <template #icon><n-icon><Send /></n-icon></template>
                </n-button>
              </div>
            </div>
          </n-layout-sider>
          
          <n-layout-content>
            <div class="content-area">
              <template v-if="activeKey === 'chat'">
                <div class="stream-embed">
                  <iframe v-if="channelName" 
                    :src="`https://player.twitch.tv/?channel=${channelName}&parent=${window.location.hostname}&muted=false&autoplay=true`"
                    frameborder="0" allowfullscreen allow="autoplay"></iframe>
                  <div v-else class="no-stream">Выберите канал в настройках</div>
                </div>
              </template>
              
              <template v-else-if="activeKey === 'accounts'">
                <div class="accounts-panel">
                  <div class="accounts-header">
                    <n-alert type="info">
                      👁 <b>Присутствие 100%</b> — каждый бот смотрит стрим как залогиненный пользователь
                    </n-alert>
                  </div>
                  
                  <div class="bots-config" style="flex-wrap: wrap;">
                    <span>Отвечают:</span>
                    <n-button-group size="small">
                      <n-button v-for="i in 6" :key="i" size="tiny"
                               :type="botsPerTranscript === i ? 'primary' : 'default'"
                               @click="setBotsPerTranscript(i)">{{ i }}</n-button>
                      <n-button size="tiny"
                               :type="botsPerTranscript === 99 ? 'primary' : 'default'"
                               @click="setBotsPerTranscript(99)">Все</n-button>
                    </n-button-group>
                  </div>
                  
                  <n-scrollbar style="max-height: calc(100vh - 320px)">
                    <n-list hoverable clickable>
                      <n-list-item v-for="(bot, k) in bots" :key="k">
                        <n-thing>
                          <template #header>
                            <div class="bot-item">
                              <n-avatar :size="32" :style="{ background: getBotColor(k) }">
                                {{ bot.username[0].toUpperCase() }}
                              </n-avatar>
                              <div class="bot-info">
                                <span class="bot-name">{{ bot.username }}</span>
                                <span class="bot-status" :class="bot.state">{{ bot.displayState || bot.state }}</span>
                                <span class="bot-points" v-if="false">🪙 {{ bot.points }} pts</span>
                              </div>
                            </div>
                          </template>
                          <template #header-extra>
                            <div class="bot-actions">
                              <n-tag :type="bot.state === 'connected' ? 'success' : 'warning'" size="small">
                                {{ bot.state }}
                              </n-tag>
                              <n-button size="small" @click="toggleBotSelection(k)">
                                {{ selectedBots.has(k) ? '✓' : '○' }}
                              </n-button>
                            </div>
                          </template>
                        </n-thing>
                      </n-list-item>
                    </n-list>
                  </n-scrollbar>
                </div>
              </template>
              
              <template v-else-if="activeKey === 'phrases'">
                <div class="phrases-panel">
                  <div class="phrases-header">
                    <n-button type="primary">+ Добавить группу</n-button>
                    <span class="hint">Сохраняется автоматически</span>
                  </div>
                  <n-grid :cols="4" :x-gap="12" :y-gap="12">
                    <n-grid-item v-for="(plist, key) in phrases" :key="key">
                      <n-card size="small" :title="key">
                        <template #header-extra>
                          <n-button-group size="tiny">
                            <n-button size="small">✎</n-button>
                            <n-button size="small">✕</n-button>
                          </n-button-group>
                        </template>
                        <div class="phrase-list">
                          <div v-for="p in plist" :key="p" class="phrase-item">· {{ p }}</div>
                        </div>
                        <n-button block size="small" @click="sendPhrase(key)">Отправить</n-button>
                      </n-card>
                    </n-grid-item>
                  </n-grid>
                </div>
              </template>
              
              <template v-else-if="activeKey === 'transcript'">
                <div class="transcript-panel">
                  <div class="transcript-header">
                    <n-button @click="socket.emit('get:transcript')">Обновить</n-button>
                  </div>
                  <n-scrollbar style="max-height: calc(100vh - 200px)">
                    <n-card v-for="(sess, idx) in transcriptHistory" :key="idx" size="small" class="transcript-card">
                      <template #header>
                        <span class="heard-label">🎙 {{ new Date(sess.timestamp).toTimeString().slice(0, 8) }}</span>
                      </template>
                      <div class="heard-text">{{ sess.text }}</div>
                      <n-divider>Ответы ботов</n-divider>
                      <div v-for="resp in sess.responses" :key="resp.username" class="response-item">
                        <span class="resp-name" :style="{ color: getBotColor(resp.username) }">{{ resp.username }}</span>
                        <span class="resp-msg">{{ resp.message }}</span>
                      </div>
                      <div v-if="!sess.responses.length" class="no-responses">Боты ещё не ответили...</div>
                    </n-card>
                  </n-scrollbar>
                </div>
              </template>
              
              <template v-else-if="activeKey === 'learn'">
                <div class="learn-panel">
                  <div class="learn-header">
                    <n-alert type="info">
                      🤖 <b>Обучение Markov</b> — боты обучаются на сообщениях из другого канала пока вы стримите
                    </n-alert>
                  </div>
                  
                  <n-card title="Настройка обучения">
                    <n-alert type="warning">
                      Настройки берутся из Variables: LEARN_CHANNEL и LEARN_OAUTH
                    </n-alert>
                    <n-divider />
                    <n-space>
                      <n-button type="primary" @click="startLearning" :disabled="learning">Старт</n-button>
                      <n-button type="error" @click="stopLearning" :disabled="!learning">Стоп</n-button>
                    </n-space>
                  </n-card>
                  
                  <n-card v-if="learning" title="Статус обучения">
                    <div class="learn-stats">
                      <n-statistic label="Сообщений изучено">{{ learnStats.messages }}</n-statistic>
                      <n-statistic label="Слов в базе">{{ learnStats.words }}</n-statistic>
                    </div>
                    <n-divider />
                    <div class="learn-log">
                      <n-scrollbar style="max-height: 200px">
                        <div v-for="(msg, idx) in learnLogs" :key="idx" class="learn-msg">
                          {{ msg }}
                        </div>
                      </n-scrollbar>
                    </div>
                  </n-card>
                </div>
              </template>
            </div>
          </n-layout-content>
        </n-layout>
      </n-layout>
    </n-layout>
    
    <div v-if="errorsList.length" class="error-bar">
      <div class="error-header" @click="errorsList.length = 0">
        <span>⚠ Ошибки: {{ errorsList.length }}</span>
      </div>
      <div class="error-list">
        <div v-for="(e, idx) in errorsList" :key="idx" class="error-item">
          {{ e.time }} {{ e.username }}: {{ e.message }}
        </div>
      </div>
    </div>
  </n-config-provider>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --bg: #111114;
  --sf: #18181c;
  --ca: #1e1e24;
  --b1: #2a2a32;
  --b2: #333340;
  --pu: #7c3aed;
  --pl: #9d5cf6;
  --pd: rgba(124, 58, 237, 0.15);
  --tx: #e8e8f0;
  --tx2: #9898b0;
  --tx3: #55556a;
  --gr: #22c55e;
  --rd: #ef4444;
  --yw: #f59e0b;
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--tx);
  overflow: hidden;
}

.app-layout {
  height: 100vh;
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--b1);
}

.logo-icon {
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, var(--pu), #ec4899);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.logo-text {
  font-weight: 700;
  font-size: 15px;
}

.top-bar {
  height: 44px;
  background: var(--sf);
  border-bottom: 1px solid var(--b1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}

.top-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-name {
  font-weight: 600;
  font-size: 14px;
}

.game-name {
  color: var(--tx3);
  font-size: 13px;
}

.top-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--tx2);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.main-content {
  height: calc(100vh - 44px);
}

.panel-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--sf);
  border-right: 1px solid var(--b1);
}

.chat-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--b1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: var(--tx2);
}

.chat-messages {
  padding: 8px;
}

.chat-message {
  display: flex;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
}

.chat-message:hover {
  background: rgba(255, 255, 255, 0.03);
}

.chat-message.system {
  color: var(--tx3);
  font-style: italic;
  font-size: 12px;
}

.msg-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.msg-username {
  font-weight: 600;
  font-size: 12px;
}

.msg-text {
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
}

.empty-chat {
  text-align: center;
  padding: 40px;
  color: var(--tx3);
  font-size: 13px;
}

.phrase-bar {
  padding: 8px 12px;
  border-top: 1px solid var(--b1);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chat-input {
  padding: 10px 12px;
  border-top: 1px solid var(--b1);
  display: flex;
  gap: 8px;
}

.content-area {
  height: 100%;
  background: var(--bg);
}

.stream-embed {
  width: 100%;
  height: 100%;
  background: #0a0a0c;
}

.stream-embed iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.no-stream {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--tx3);
}

.accounts-panel {
  padding: 16px;
}

.accounts-header {
  margin-bottom: 16px;
}

.bots-config {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 10px;
  background: rgba(34, 197, 94, 0.06);
  border: 1px solid rgba(34, 197, 94, 0.15);
  border-radius: 8px;
}

.bot-item {
  display: flex;
  gap: 10px;
  align-items: center;
}

.bot-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bot-name {
  font-weight: 600;
  font-size: 13px;
}

.bot-status {
  font-size: 11px;
  color: var(--tx3);
}

.bot-status.connected {
  color: var(--gr);
}

.bot-status.connecting {
  color: var(--yw);
}

.bot-status.error {
  color: var(--rd);
}

.bot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.phrases-panel {
  padding: 16px;
}

.phrases-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.hint {
  color: var(--tx3);
  font-size: 12px;
}

.phrase-list {
  font-size: 11px;
  color: var(--tx2);
  line-height: 1.6;
  margin-bottom: 10px;
}

.transcript-panel,
.learn-panel {
  padding: 16px;
}

.learn-header {
  margin-bottom: 16px;
}

.learn-stats {
  display: flex;
  gap: 24px;
}

.learn-log {
  font-size: 11px;
  font-family: monospace;
}

.learn-msg {
  padding: 2px 0;
}

.transcript-header {
  margin-bottom: 16px;
}

.transcript-card {
  margin-bottom: 12px;
}

.heard-label {
  font-size: 11px;
  color: var(--pl);
}

.heard-text {
  font-size: 13px;
  color: var(--tx2);
  line-height: 1.5;
}

.response-item {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--b1);
}

.response-item:last-child {
  border-bottom: none;
}

.resp-name {
  font-weight: 600;
  font-size: 12px;
  min-width: 80px;
}

.resp-msg {
  font-size: 12px;
}

.no-responses {
  color: var(--tx3);
  font-style: italic;
  font-size: 12px;
}

.error-bar {
  position: fixed;
  bottom: 0;
  left: 220px;
  right: 0;
  background: rgba(239, 68, 68, 0.1);
  border-top: 1px solid rgba(239, 68, 68, 0.3);
  z-index: 100;
}

.error-header {
  padding: 8px 16px;
  cursor: pointer;
  color: var(--rd);
  font-weight: 600;
}

.error-list {
  padding: 0 16px 12px;
  max-height: 120px;
  overflow-y: auto;
}

.error-item {
  font-size: 11px;
  color: var(--rd);
  padding: 2px 0;
  font-family: monospace;
}
</style>