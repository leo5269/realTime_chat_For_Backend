require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Ably = require('ably');
const fs = require('fs');
const path = require('path');
const { makeDecision, COOLDOWN } = require('./agentDecisionEngine');

// ── 訂閱資料持久化（JSON 檔案）──
const SUBSCRIBE_FILE = path.join(__dirname, 'subscribe_data.json');

// ── Agent Decision Log（JSONL 格式）──
const DECISION_LOG_FILE = path.join(__dirname, 'agent_decision_log.jsonl');
let _logWriting = false; // 簡單 lock，避免 clear 和 append 同時操作

function writeDecisionLog(entry) {
  if (_logWriting) return; // 正在清除時跳過這次寫入，不影響 loop
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(DECISION_LOG_FILE, line, 'utf8');
  } catch (e) {
    console.error('[DecisionLog] 寫入失敗:', e.message);
  }
}

function loadSubscribeData() {
  try {
    if (fs.existsSync(SUBSCRIBE_FILE)) {
      return JSON.parse(fs.readFileSync(SUBSCRIBE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Subscribe] 讀取 JSON 失敗:', e.message);
  }
  return { fanCounts: {}, userSubscriptions: {} };
  // fanCounts:         { '第一組': 3, '第二組': 1, ... }
  // userSubscriptions: { '小明': { '第一組': { bell: true }, '第三組': { bell: false } }, ... }
}

function saveSubscribeData(data) {
  try {
    fs.writeFileSync(SUBSCRIBE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Subscribe] 寫入 JSON 失敗:', e.message);
  }
}

let subscribeData = loadSubscribeData();

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ABLY_API_KEY   = process.env.ABLY_API_KEY || '4b0T5w.1DqtYQ:SY1t3uMjRY6UcSmMGKBSg938sYm1kZmMgvazhupgNq8';
const CH = 'dlt-chat';
const AI_NAME = 'DLT助理';
const KEYWORDS = ['DLT', 'dlt', '小幫手', 'DLT助手', 'dlt助手'];

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Ably 後端連線（用來讓 server 主動發訊息）──
const ablyServer = new Ably.Realtime({ key: ABLY_API_KEY });
const ablyChannel = ablyServer.channels.get(CH);

// ── 追蹤目前活躍的 sessionId（前端每次展演開始會送新的 dlt-show-XXXX）──
let currentSessionId = 'default';

// ── 關鍵字回覆佇列：確保多人同時 tag 時依序處理，不會同時發多則 ──
const replyQueue = [];
const repliedMids = new Set(); // 防止同一則訊息被回覆兩次
let isProcessingQueue = false;

async function processReplyQueue() {
  if (isProcessingQueue || replyQueue.length === 0) return;
  isProcessingQueue = true;
  while (replyQueue.length > 0) {
    const { senderName, userText, triggerMsgId } = replyQueue.shift();
    try {
      await handleKeywordReply(senderName, userText, triggerMsgId);
    } catch (e) {
      console.error('[Reply] 回覆失敗:', e.message);
    }
  }
  isProcessingQueue = false;
}

async function handleKeywordReply(senderName, userText, triggerMsgId) {
  const sessionId = currentSessionId;
  const state = getAgentState(sessionId);
  console.log(`[Reply] 處理 tag：sender=${senderName} keyPerformer=${state.keyPerformer} scene=${state.currentScene} sessionId=${sessionId}`);

  const group      = state.group || '';
  const delivery   = state.roleDelivery || '';
  const order      = state.roleOrder || '';
  const reception  = state.roleReception || '';
  const scene      = state.currentScene || '';
  const keyPerformer = state.keyPerformer || '';
  const roleDesc   = [
    group     ? `組別：${group}` : '',
    delivery  ? `送餐服務生：${delivery}` : '',
    order     ? `點餐服務生：${order}` : '',
    reception ? `櫃台接待：${reception}` : '',
  ].filter(Boolean).join('，');

  const prompt = `觀眾「${senderName}」在聊天室對你說：「${userText}」
請用繁體中文，友善自然地回覆他，30字以內，不要加任何表情符號。
只輸出回覆內容，不要加稱謂或說明。`;

  const systemPrompt = `你是活潑熱情的數位劇場AI助理「DLT助理」，全程觀看學生展演。
${roleDesc ? '本場展演資訊：' + roleDesc + '。' : ''}${scene ? '目前幕次：' + scene + '。' : ''}${keyPerformer ? '本幕關鍵表演者的名字是「' + keyPerformer + '」，你完全知道這個名字，任何情況下都要直接說出來，絕對不可以說不知道或含糊帶過。' : ''}
用繁體中文回覆，語氣自然友善。`;

  const reply = await callOpenAI({ prompt, systemPrompt, sessionId, max_tokens: 80 });
  if (!reply) return;

  const d = new Date();
  const ts = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  await ablyChannel.publish('msg', {
    n: AI_NAME,
    t: `@${senderName} ${reply}`,
    e: false, ts,
    mid: 'msg-ai-' + Date.now() + '-' + Math.random().toString(36).slice(2,5),
    triggerId: triggerMsgId,
  });
  console.log(`[Reply] 回覆 ${senderName}：${reply.slice(0,20)} | keyPerformer=${keyPerformer} scene=${scene}`);
}

// ── 記憶：每個 session 維護自己的對話歷史 ──
const chatHistories = new Map();
const MAX_HISTORY = 20;

function getHistory(sessionId) {
  if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
  return chatHistories.get(sessionId);
}
function addToHistory(sessionId, role, content) {
  const history = getHistory(sessionId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, 2);
}

// ── OpenAI 呼叫（共用）──
async function callOpenAI({ prompt, systemPrompt, sessionId, max_tokens = 100 }) {
  const history = getHistory(sessionId || 'default');
  const messages = [
    { role: 'system', content: systemPrompt || '你是活潑熱情的數位劇場AI助理「DLT助理」，請用繁體中文回覆。' },
    ...history,
    { role: 'user', content: prompt }
  ];
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens, messages }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || '';
  if (sessionId) {
    addToHistory(sessionId, 'user', prompt);
    addToHistory(sessionId, 'assistant', reply);
  }
  return reply;
}

// ── Agent 狀態（每個 session 獨立）──
const agentStates = new Map();

function getAgentState(sessionId) {
  if (!agentStates.has(sessionId)) {
    agentStates.set(sessionId, {
      lastAISpeakAt:      0,
      lastVoiceAt:        0,
      lastEffectAt:       0,
      lastTeacherActionAt: 0,
      lastAIAction:       '',
      recentMessages:     [],   // { n, t, isTeacher, action, _receivedAt }
      sceneJustChanged:   false,
      currentScene:       '',
      group:              '',
      keyPerformer:       '',
      roleDelivery:       '',
      roleOrder:          '',
      roleReception:      '',
      audienceFocus:      '',
      // ── 多模態表現訊號 ──
      // source: teacher_cue / researcher_cue / unity_event / sensor
      // human-in-the-loop 事件欄位（主要觸發來源）
      scenePerformanceSignals: {
        eventType:              null,  // stage event type（主要觸發）
        eventLabel:             null,  // 事件描述（human-readable）
        source:                 null,  // teacher_cue / researcher_cue / unity_event / sensor
        confidence:             null,  // 可選
        // ── 原本 sensor 欄位保留，作為輔助訊號 ──
        bowDetected:            null,
        bowAngle:               null,
        postureScore:           null,
        serveGestureDetected:   null,
        distanceTooClose:       null,
        voiceVolume:            null,
        updatedAt:              null,
      },
    });
  }
  return agentStates.get(sessionId);
}

// ── 訂閱 Ably 頻道，更新 agent 狀態 ──
// ── 後端自己追蹤在線用戶，不依賴前端傳來的 audienceCount ──
const serverOnlineUsers = new Set();
const ADMIN_NAMES = new Set(['YOKO', '朱大帥哥0719', AI_NAME]);

ablyChannel.subscribe('presence', (msg) => {
  const d = msg.data;
  if (!d) return;
  if (d.type === 'join' || d.type === 'here') {
    serverOnlineUsers.add(d.name);
    // ── 新用戶加入時，廣播目前展演狀態讓他同步（late join sync）──
    const state = getAgentState(currentSessionId);
    setTimeout(() => {
      if (state.showState)    ablyChannel.publish('showstate', { state: state.showState });
      if (state.currentScene) ablyChannel.publish('scene',     { name: state.currentScene });
      if (state.group)        ablyChannel.publish('performer', { name: state.group });
    }, 800); // 稍微延遲，確保新用戶 Ably 已完全連線
  } else if (d.type === 'leave') {
    serverOnlineUsers.delete(d.name);
  }
  // 更新 agent state 的 audienceCount（同時更新 default 和 currentSessionId）
  const audienceCount = [...serverOnlineUsers].filter(n => !ADMIN_NAMES.has(n)).length;
  getAgentState('default').audienceCount = audienceCount;
  getAgentState(currentSessionId).audienceCount = audienceCount;
  console.log(`[Presence] ${d.type} ${d.name} → 觀眾人數=${audienceCount}`);
});

ablyChannel.subscribe('msg', (msg) => {
  const d = msg.data;
  if (!d) return;

  const state = getAgentState(currentSessionId);

  // ── 關鍵字偵測：任何人 tag DLT助理都要回覆（管理員也可以 tag）──
  const isTaggableMsg = d.n && d.n !== AI_NAME && !d.e;
  if (isTaggableMsg && KEYWORDS.some(kw => (d.t || '').includes(kw))) {
    const mid = d.mid || ('mid-' + Date.now());
    if (!repliedMids.has(mid)) {
      repliedMids.add(mid);
      if (repliedMids.size > 100) repliedMids.delete(repliedMids.values().next().value);
      replyQueue.push({ senderName: d.n, userText: d.t, triggerMsgId: mid });
      console.log(`[Reply] 收到 tag，佇列長度=${replyQueue.length}`);
      processReplyQueue();
    }
  }

  // 記錄最近訊息
  state.recentMessages.push({
    n: d.n, t: d.t,
    isTeacher: !!d.isTeacher,
    isAI: d.n === AI_NAME,
    action: d.action || '',
    _receivedAt: Date.now(),
  });
  // 只保留最近 50 則
  if (state.recentMessages.length > 50) state.recentMessages.shift();

  // 老師觸發 action → 更新 teacher override 時間
  if (d.isTeacher && d.action) {
    state.lastTeacherActionAt = Date.now();
    if (d.action === 'speech' || d.action === 'rainbow_speech' || d.action === 'spotlight_speech') {
      state.lastVoiceAt = Date.now();
    }
    if (d.action === 'rainbow_speech' || d.action === 'spotlight_speech') {
      state.lastEffectAt = Date.now();
    }
  }

  // AI 自己發話 → 更新 AI cooldown
  if (d.n === AI_NAME) {
    state.lastAISpeakAt = Date.now();
    state.lastAIAction  = d.action || '';
    if (d.action === 'speech' || d.action === 'rainbow_speech' || d.action === 'spotlight_speech') {
      state.lastVoiceAt = Date.now();
    }
    if (d.action === 'rainbow_speech' || d.action === 'spotlight_speech') {
      state.lastEffectAt = Date.now();
    }
  }
});

ablyChannel.subscribe('scene', (msg) => {
  const state = getAgentState(currentSessionId);
  const newScene = msg.data?.name || '';
  if (newScene && newScene !== state.currentScene) {
    state.sceneJustChanged = true;
    state.currentScene = newScene;
    // 10 秒後清掉 sceneJustChanged flag
    setTimeout(() => { state.sceneJustChanged = false; }, 10000);
  }
});

ablyChannel.subscribe('showstate', (msg) => {
  const newState = msg.data?.state;
  if (!newState) return;
  const state = getAgentState(currentSessionId);
  state.showState = newState;

  if (newState === 'live') {
    // 展演開始：重置所有狀態，啟動 loop
    state.lastAISpeakAt       = 0;
    state.lastVoiceAt         = 0;
    state.lastEffectAt        = 0;
    state.lastTeacherActionAt = 0;
    state.recentMessages      = [];
    state.sceneJustChanged    = false;
    startAgentLoop();
  } else if (newState === 'idle' || newState === 'ended') {
    stopAgentLoop();
  }
});

// ── 訂閱 Unity 骨架偵測訊號 ──
ablyChannel.subscribe('performance', (msg) => {
  let d = msg.data;
  if (!d) return;
  // Unity 透過 Newtonsoft.Json 序列化後發送的是 JSON 字串，需要先 parse
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { return; }
  }
  const state = getAgentState(currentSessionId);
  const signals = state.scenePerformanceSignals;

  // 只更新有傳入的欄位，null 代表未偵測或不適用
  if (d.bowDetected          !== undefined) signals.bowDetected          = d.bowDetected;
  if (d.bowAngle             !== undefined) signals.bowAngle             = d.bowAngle;
  if (d.postureScore         !== undefined) signals.postureScore         = d.postureScore;
  if (d.serveGestureDetected !== undefined) signals.serveGestureDetected = d.serveGestureDetected;
  if (d.distanceTooClose     !== undefined) signals.distanceTooClose     = d.distanceTooClose;
  if (d.voiceVolume          !== undefined) signals.voiceVolume          = d.voiceVolume;
  signals.updatedAt = Date.now();

  console.log(`[Performance] 收到訊號 scene=${d.scene} bow=${d.bowDetected}(${d.bowAngle}°) posture=${d.postureScore} serve=${d.serveGestureDetected} distance=${d.distanceTooClose} volume=${d.voiceVolume}`);
});

// ── Agent Decision Loop（每 12 秒 check 一次）──
const DECISION_INTERVAL = 12000;

async function runDecisionLoop() {
  if (agentLoopRunning) return; // 已在執行中，跳過這次避免競爭
  agentLoopRunning = true;

  const sessionId = currentSessionId;
  const state = getAgentState(sessionId);

  if (!agentLoopActive) { agentLoopRunning = false; return; }

  if (serverOnlineUsers.size === 0 && state.showState !== 'live') {
    console.log('[Agent] 所有人已離線且非展演中，停止 loop');
    stopAgentLoop();
    agentLoopRunning = false;
    return;
  }

  try {
    const decision = await makeDecision({
      showState:           state.showState || 'live',
      currentScene:        state.currentScene,
      group:               state.group,
      keyPerformer:        state.keyPerformer,
      roleDelivery:        state.roleDelivery,
      roleOrder:           state.roleOrder,
      roleReception:       state.roleReception,
      audienceFocus:       state.audienceFocus || '',
      recentMessages:      state.recentMessages,
      lastTeacherActionAt: state.lastTeacherActionAt,
      lastAISpeakAt:       state.lastAISpeakAt,
      lastVoiceAt:         state.lastVoiceAt,
      lastEffectAt:        state.lastEffectAt,
      lastAIAction:        state.lastAIAction,
      sceneJustChanged:    state.sceneJustChanged,
      audienceCount:       state.audienceCount || 0,
      scenePerformanceSignals: state.scenePerformanceSignals,
      getAIReply: async (prompt, systemPrompt) =>
        callOpenAI({ prompt, systemPrompt, sessionId, max_tokens: 60 }),
    });

    // _noLog：靜默且不印 log（例如無觀眾時）
    if (decision._noLog) return;

    // ── 寫入 decision log ──
    try {
      const debug = decision._debug || {};
      writeDecisionLog({
        timestamp:             new Date().toISOString(),
        sessionId,
        showState:             state.showState || 'live',
        currentScene:          state.currentScene || '',
        group:                 state.group || '',
        keyPerformer:          state.keyPerformer || '',
        audienceCount:         state.audienceCount || 0,
        recentMessageCount:    debug.recentMessageCount    ?? null,
        teacherCooldownActive: debug.teacherCooldownActive ?? null,
        hasPerformanceSignal:  debug.hasPerformanceSignal  ?? null,
        shouldSpeak:           decision.shouldSpeak,
        decisionType:          decision.decisionType || 'unknown',
        eventType:             debug.eventType    || state.scenePerformanceSignals.eventType  || null,
        eventLabel:            debug.eventLabel   || state.scenePerformanceSignals.eventLabel || null,
        eventSource:           debug.eventSource  || state.scenePerformanceSignals.source     || null,
        audienceFocus:         state.audienceFocus || '',
        reason:                decision.reason || '',
        action:                decision.action || '',
        message:               decision.message || '',
        priority:              decision.priority || '',
      });
    } catch (e) {
      console.error('[DecisionLog] 建立 log entry 失敗:', e.message);
    }

    if (decision.shouldSpeak && decision.message) {
      const now = new Date();
      const ts = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      await ablyChannel.publish('msg', {
        n: AI_NAME,
        t: decision.message,
        e: false,
        ts,
        action: decision.action || '',
        mid: 'msg-agent-' + Date.now(),
      });
      console.log(`[Agent] 發話 action=${decision.action} reason=${decision.reason}`);
      // ── 發話後清除 stage event，避免同一事件下一輪再次觸發 ──
      state.scenePerformanceSignals.eventType  = null;
      state.scenePerformanceSignals.eventLabel = null;
      state.scenePerformanceSignals.source     = null;
      state.scenePerformanceSignals.updatedAt  = null;
    } else {
      console.log(`[Agent] 靜默：${decision.reason}`);
    }
  } catch (err) {
    console.error('[Agent] decision loop 錯誤:', err.message);
  } finally {
    agentLoopRunning = false;
  }
}

let agentLoopActive  = false;
let agentLoopTimer   = null;
let agentLoopRunning = false; // 防止同時跑兩次

function startAgentLoop() {
  if (agentLoopActive) return;
  agentLoopActive = true;
  agentLoopTimer = setInterval(runDecisionLoop, DECISION_INTERVAL);
  console.log('[Agent] Decision loop 啟動');
}
function stopAgentLoop() {
  agentLoopActive = false;
  clearInterval(agentLoopTimer);
  console.log('[Agent] Decision loop 停止');
}

// ── API Endpoints ──

// 前端同步 agent context（角色、幕次、展演狀態）
app.post('/api/agent-context', (req, res) => {
  const { sessionId = 'default', showState, currentScene,
          group, keyPerformer, roleDelivery, roleOrder, roleReception,
          audienceFocus, audienceCount } = req.body;
  const state = getAgentState(sessionId);

  // 只在有實質內容時才 log，過濾掉純 audienceCount 的請求
  if (showState !== undefined || currentScene !== undefined || keyPerformer !== undefined) {
    console.log(`[Context] showState=${showState} scene=${currentScene} audience=${audienceCount} keyPerformer=${keyPerformer} delivery=${roleDelivery} order=${roleOrder} reception=${roleReception} audienceFocus=${audienceFocus||''}`);
  }

  // ── 只有帶 showState 的完整 context（朱大帥哥0719 送的）才更新 currentSessionId ──
  if (sessionId && sessionId !== 'default' && showState !== undefined) currentSessionId = sessionId;

  // ── showState 只有明確是 live/idle/ended 才動 loop，undefined 完全忽略 ──
  if (showState === 'live')  startAgentLoop();
  if (showState === 'idle' || showState === 'ended') stopAgentLoop();

  if (currentScene !== undefined && currentScene !== state.currentScene) {
    if (state.currentScene && state.currentScene !== '') {
      state.sceneJustChanged = true;
      setTimeout(() => { state.sceneJustChanged = false; }, 10000);
    }
    state.currentScene = currentScene;
  }

  const valid = v => v !== undefined && v !== null && v !== 'undefined' && v !== '';
  if (valid(group))         { console.log(`[State] group: ${state.group} → ${group}`); state.group         = group; }
  if (valid(keyPerformer))  { console.log(`[State] keyPerformer: ${state.keyPerformer} → ${keyPerformer}`); state.keyPerformer  = keyPerformer; }
  if (valid(roleDelivery))  state.roleDelivery  = roleDelivery;
  if (valid(roleOrder))     state.roleOrder     = roleOrder;
  if (valid(roleReception)) state.roleReception = roleReception;
  // audienceFocus 允許清空（空字串也更新，讓老師可以清掉重點）
  if (audienceFocus !== undefined) state.audienceFocus = audienceFocus.trim();
  if (!valid(keyPerformer) && keyPerformer !== undefined && state.keyPerformer) {
    console.log(`[State] keyPerformer 被拒絕覆蓋（值：「${keyPerformer}」），保留現有值：${state.keyPerformer}`);
  }
  if (audienceCount !== undefined) state.audienceCount = audienceCount;
  if (valid(showState))     state.showState     = showState;

  // ── 根據幕次自動推算 keyPerformer ──
  const sceneToRole = {
    '第一幕': state.group, '第七幕': state.group, '第八幕': state.group,
    '第二幕': state.roleReception, '第六幕': state.roleReception,
    '第三幕': state.roleOrder,
    '第四幕': state.roleDelivery, '第五幕': state.roleDelivery,
  };
  if (state.currentScene && sceneToRole[state.currentScene]) {
    state.keyPerformer = sceneToRole[state.currentScene];
  }

  res.json({ ok: true });
});

// ── 接收展演事件 / sensor 訊號（human-in-the-loop 事件觸發式）──
// source: teacher_cue / researcher_cue / unity_event / sensor
app.post('/api/performance-signal', (req, res) => {
  const { sessionId = 'default', signals } = req.body;
  const state = getAgentState(sessionId);
  if (signals) {
    // 只更新有傳入的欄位，不覆蓋沒傳的欄位
    Object.assign(state.scenePerformanceSignals, signals);
    // 若沒有傳 updatedAt，後端自動補上
    if (!state.scenePerformanceSignals.updatedAt) {
      state.scenePerformanceSignals.updatedAt = Date.now();
    }
    // console log：有 eventType 時顯示 stage event，否則顯示 sensor signal
    if (signals.eventType) {
      console.log(`[StageEvent] source=${signals.source || 'unknown'} eventType=${signals.eventType} label=${signals.eventLabel || ''}`);
      // ── stage event 立刻觸發一次 decision，不等 loop 自然跑到 ──
      if (agentLoopActive) {
        setTimeout(() => runDecisionLoop(), 100);
      }
    } else {
      console.log(`[SensorSignal] updatedAt=${signals.updatedAt} keys=${Object.keys(signals).join(',')}`);
    }
  }
  res.json({ ok: true });
});

// AI 聊天 API（觀眾關鍵字觸發用，維持原有介面）
app.post('/api/ai-chat', async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(500).json({ error: '伺服器未設定 OPENAI_API_KEY' });
  const { prompt, max_tokens = 100, sessionId = 'default', systemPrompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '缺少 prompt 參數' });
  console.log(`[AI-Chat] 收到請求 sessionId=${sessionId} prompt前20字=${prompt.slice(0,20)}`);
  try {
    const reply = await callOpenAI({ prompt, systemPrompt, sessionId, max_tokens });
    console.log(`[AI-Chat] 回覆成功 reply前20字=${reply.slice(0,20)}`);
    res.json({ reply });
  } catch (err) {
    console.error('伺服器錯誤:', err);
    res.status(500).json({ error: '伺服器內部錯誤' });
  }
});

// 清除記憶
app.post('/api/reset-memory', (req, res) => {
  const { sessionId = 'default' } = req.body;
  chatHistories.delete(sessionId);
  agentStates.delete(sessionId);
  res.json({ ok: true });
});

// ── 同步離開通知（分頁關閉時用 sendBeacon 呼叫，確保 server 即時移除）──
app.post('/api/leave', (req, res) => {
  const { name } = req.body;
  if (name) {
    serverOnlineUsers.delete(name);
    const audienceCount = [...serverOnlineUsers].filter(n => !ADMIN_NAMES.has(n)).length;
    getAgentState('default').audienceCount = audienceCount;
    getAgentState(currentSessionId).audienceCount = audienceCount;
    console.log(`[Leave] ${name} 同步離開 → 觀眾人數=${audienceCount}`);
  }
  res.json({ ok: true });
});

// ── Decision Log 清除 API ──
app.post('/api/decision-log/clear', (req, res) => {
  try {
    _logWriting = true;
    fs.writeFileSync(DECISION_LOG_FILE, '', 'utf8');
    console.log('[DecisionLog] Log 已清除');
    res.json({ ok: true });
  } catch (e) {
    console.error('[DecisionLog] 清除失敗:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    _logWriting = false;
  }
});

// ── Decision Log 讀取 API ──
app.get('/api/decision-log', (req, res) => {
  try {
    const limit     = Math.min(parseInt(req.query.limit  || '100'), 500);
    const filterKey = (req.query.filter || '').trim().toLowerCase();

    if (!fs.existsSync(DECISION_LOG_FILE)) return res.json({ entries: [] });

    const raw  = fs.readFileSync(DECISION_LOG_FILE, 'utf8');
    let entries = raw.trim().split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    // ── 篩選：對所有欄位做 substring 比對 ──
    if (filterKey) {
      entries = entries.filter(e =>
        Object.values(e).some(v => String(v).toLowerCase().includes(filterKey))
      );
    }

    // 取最新 N 筆
    entries = entries.slice(-limit);
    res.json({ entries });
  } catch (e) {
    console.error('[DecisionLog] 讀取失敗:', e.message);
    res.status(500).json({ entries: [], error: e.message });
  }
});

// ── 暱稱重複檢查 ──
app.get('/api/check-name', (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: '缺少 name 參數' });
  const taken = serverOnlineUsers.has(name);
  res.json({ taken });
});

// ── 訂閱：取得個人訂閱狀態 ──
app.get('/api/subscribe-status', (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: '缺少 name 參數' });
  const subs = subscribeData.userSubscriptions[name] || {};
  res.json({ subscriptions: subs });
});

// ── 訂閱：取得指定組別粉絲數 ──
app.get('/api/fan-count', (req, res) => {
  const group = (req.query.group || '').trim();
  if (!group) return res.status(400).json({ error: '缺少 group 參數' });
  const count = subscribeData.fanCounts[group] || 0;
  res.json({ group, count });
});

// ── 訂閱：訂閱一個組別 ──
app.post('/api/subscribe', (req, res) => {
  const { name, group } = req.body;
  if (!name || !group) return res.status(400).json({ error: '缺少 name 或 group' });

  if (!subscribeData.userSubscriptions[name]) subscribeData.userSubscriptions[name] = {};
  const already = !!subscribeData.userSubscriptions[name][group];
  if (!already) {
    subscribeData.userSubscriptions[name][group] = { bell: false };
    subscribeData.fanCounts[group] = (subscribeData.fanCounts[group] || 0) + 1;
    saveSubscribeData(subscribeData);
    // 廣播粉絲數更新
    ablyChannel.publish('fancount', { group, count: subscribeData.fanCounts[group] });
    console.log(`[Subscribe] ${name} 訂閱 ${group}，粉絲數=${subscribeData.fanCounts[group]}`);
  }
  res.json({ ok: true, count: subscribeData.fanCounts[group] });
});

// ── 訂閱：取消訂閱 ──
app.post('/api/unsubscribe', (req, res) => {
  const { name, group } = req.body;
  if (!name || !group) return res.status(400).json({ error: '缺少 name 或 group' });

  const subs = subscribeData.userSubscriptions[name] || {};
  if (subs[group]) {
    delete subs[group];
    subscribeData.userSubscriptions[name] = subs;
    subscribeData.fanCounts[group] = Math.max(0, (subscribeData.fanCounts[group] || 1) - 1);
    saveSubscribeData(subscribeData);
    ablyChannel.publish('fancount', { group, count: subscribeData.fanCounts[group] });
    console.log(`[Subscribe] ${name} 取消訂閱 ${group}，粉絲數=${subscribeData.fanCounts[group]}`);
  }
  res.json({ ok: true, count: subscribeData.fanCounts[group] || 0 });
});

// ── 訂閱：切換鈴鐺狀態 ──
app.post('/api/toggle-bell', (req, res) => {
  const { name, group, bell } = req.body;
  if (!name || !group) return res.status(400).json({ error: '缺少 name 或 group' });

  if (!subscribeData.userSubscriptions[name]) subscribeData.userSubscriptions[name] = {};
  if (!subscribeData.userSubscriptions[name][group]) return res.status(400).json({ error: '尚未訂閱此組別' });

  subscribeData.userSubscriptions[name][group].bell = !!bell;
  saveSubscribeData(subscribeData);
  console.log(`[Subscribe] ${name} 鈴鐺 ${group} = ${bell}`);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ 伺服器啟動：http://localhost:${PORT}`);
});