/**
 * DLT AI Agent Decision Engine v2.0
 *
 * 職責：根據現場狀況決定 AI 要不要說話、說什麼、用什麼 action
 * 設計原則：最小侵入式，可擴充，Teacher > AI
 *
 * 發話邏輯：
 *   1. performance 訊號到達 → 立刻條件式評論（受 aiSpeak cooldown 限制，避免連發，只讓 YOKO）
 *   2. 場子太安靜 → 暖場（純文字彈幕，無語音）
 *   3. 移除固定定時鼓勵
 */

// ── Cooldown 設定 ──
const COOLDOWN = {
  speech:       4000,   // 語音 cooldown（ms）
  effect:       3000,   // 特效 cooldown（ms）
  aiSpeak:      20000,  // AI 發話最短間隔（ms）
  teacher:      8000,   // 老師（YOKO）操作後 AI 讓路時間（ms）
  performance:  30000,  // performance 回饋有效期（ms），30 秒內的新資料才觸發
};

// ── 互動密度判斷門檻 ──
const DENSITY_HIGH_THRESHOLD = 5;  // 最近 15 秒超過幾則訊息算熱鬧

/**
 * 主要 decision 函式
 *
 * @param {Object} ctx - 現場 context
 * @param {string} ctx.currentScene
 * @param {string} ctx.group
 * @param {string} ctx.keyPerformer
 * @param {string} ctx.roleDelivery
 * @param {string} ctx.roleOrder
 * @param {string} ctx.roleReception
 * @param {Array}  ctx.recentMessages
 * @param {number} ctx.lastTeacherActionAt
 * @param {number} ctx.lastAISpeakAt
 * @param {number} ctx.lastVoiceAt
 * @param {number} ctx.lastEffectAt
 * @param {string} ctx.lastAIAction
 * @param {Object} ctx.scenePerformanceSignals
 * @param {Function} ctx.getAIReply
 *
 * @returns {Object} decision
 */
// ── 根據 reason 推斷 decisionType ──
function inferDecisionType(reason) {
  if (!reason) return 'unknown';
  const r = reason;
  if (r.includes('場子太安靜') || r.includes('暖場'))           return 'warmup';
  if (r.includes('performance') || r.includes('條件式評論'))    return 'performance_feedback';
  if (r.includes('YOKO') || r.includes('老師') || r.includes('讓路')) return 'teacher_override';
  if (r.includes('cooldown'))                                    return 'cooldown';
  if (r.includes('聊天室熱鬧'))                                  return 'busy_chat';
  if (r.includes('show_ended') || r.includes('展演結束'))        return 'show_ended';
  if (r.includes('no_audience') || r.includes('沒有觀眾'))       return 'no_audience';
  if (r.includes('失敗') || r.includes('錯誤'))                  return 'error';
  if (r.includes('目前不需要'))                                  return 'no_need';
  return 'unknown';
}

async function makeDecision(ctx) {
  const now = Date.now();

  const silent = (reason) => ({
    shouldSpeak: false, message: '', action: '', priority: 'low', reason
  });

  // ── 預先計算 debug metadata（供 server log 使用）──
  const recentCount    = countRecentMessages(ctx.recentMessages, 15000);
  const sig            = ctx.scenePerformanceSignals || {};
  const teacherActive  = !!(ctx.lastTeacherActionAt && now - ctx.lastTeacherActionAt < COOLDOWN.teacher);
  const freshStageEvent   = hasFreshStageEvent(sig, now);
  const freshSensorSignal = hasUsefulSensorSignal(sig, now);

  const _debug = {
    recentMessageCount:    recentCount,
    teacherCooldownActive: teacherActive,
    hasPerformanceSignal:  freshStageEvent || freshSensorSignal,
    eventType:             sig.eventType || null,
    eventLabel:            sig.eventLabel || null,
    eventSource:           sig.source || null,
  };

  // silentWithDebug 支援傳入 decisionType 覆蓋 inferDecisionType
  const silentWithDebug = (reason, dt) => ({
    shouldSpeak: false, message: '', action: '', priority: 'low', reason,
    decisionType: dt || inferDecisionType(reason), _debug
  });

  // ── 1. 展演結束時 AI 完全停止 ──
  if (ctx.showState === 'ended') {
    return { shouldSpeak: false, message: '', action: '', priority: 'low', reason: 'show_ended', decisionType: 'show_ended', _noLog: true, _debug };
  }

  // ── 2. YOKO（老師）剛發話 → AI 完全讓路 ──
  if (ctx.lastTeacherActionAt && now - ctx.lastTeacherActionAt < COOLDOWN.teacher) {
    return silentWithDebug('YOKO 剛操作，AI 讓路', 'teacher_override');
  }

  // ── 3. 沒有觀眾且不在展演中時靜默 ──
  if ((!ctx.audienceCount || ctx.audienceCount <= 0) && ctx.showState !== 'live') {
    return { shouldSpeak: false, message: '', action: '', priority: 'low', reason: 'no_audience', decisionType: 'no_audience', _noLog: true, _debug };
  }

  // ── 4. AI 發話 cooldown：太快發話 → 跳過
  // ★ stage event（human-in-the-loop teacher cue）不受 cooldown 限制
  //   sensor signal、暖場仍然受 cooldown 控制，避免 AI 連發
  const cooldownActive = !!(ctx.lastAISpeakAt && now - ctx.lastAISpeakAt < COOLDOWN.aiSpeak);
  if (cooldownActive && !freshStageEvent) {
    return silentWithDebug('AI 發話 cooldown 未結束', 'cooldown');
  }

  // ── 5. performance 觸發：stage event 優先，sensor signal 降級輔助 ──
  // context-aware decision：human-in-the-loop 事件觸發式 Audience AI Agent
  if (freshStageEvent || freshSensorSignal) {
    let message = '';
    let triggerType;

    if (freshStageEvent) {
      // ── 5a. human-in-the-loop stage event（主要觸發）──
      triggerType = 'stage_event_feedback';
      try {
        const { prompt, systemPrompt } = buildStageEventPrompt(ctx);
        message = await ctx.getAIReply(prompt, systemPrompt);
      } catch (e) {
        return silentWithDebug('stage event 回饋 OpenAI 失敗：' + e.message, 'error');
      }
      if (!message) return silentWithDebug('stage event 回饋 OpenAI 回傳空白', 'error');
    } else {
      // ── 5b. sensor signal 輔助觸發（降級使用）──
      triggerType = 'performance_feedback';
      try {
        const promptResult = buildPerformancePrompt(ctx);
        // observation 為空時，不讓 AI 亂補建議
        if (promptResult._noObservation) return silentWithDebug('沒有可用 performance observation', 'no_need');
        message = await ctx.getAIReply(promptResult.prompt, promptResult.systemPrompt);
      } catch (e) {
        return silentWithDebug('sensor performance 回饋 OpenAI 失敗：' + e.message, 'error');
      }
      if (!message) return silentWithDebug('sensor performance 回饋 OpenAI 回傳空白', 'error');
    }

    return {
      shouldSpeak:  true,
      message,
      action:       'speech',
      priority:     'high',
      reason:       freshStageEvent ? `stage event: ${sig.eventType}` : 'sensor signal 輔助回饋',
      decisionType: triggerType,
      _debug,
    };
  }

  // ── 6. 互動密度判斷：聊天室已經很熱鬧 → 跳過 ──
  if (recentCount >= DENSITY_HIGH_THRESHOLD) {
    return silentWithDebug(`聊天室熱鬧（最近15秒 ${recentCount} 則），AI 靜默`);
  }

  // ── 7. 暖場：場子太安靜超過 60 秒才說話，純文字無語音 ──
  const silentSince = ctx.lastAISpeakAt ? now - ctx.lastAISpeakAt : Infinity;
  if (silentSince > 60000 && ctx.audienceCount > 0 && recentCount === 0) {
    let message = '';
    try {
      const { prompt, systemPrompt } = buildWarmupPrompt(ctx);
      message = await ctx.getAIReply(prompt, systemPrompt);
    } catch (e) {
      return silentWithDebug('暖場 OpenAI 失敗：' + e.message);
    }
    if (!message) return silentWithDebug('暖場 OpenAI 回傳空白');

    return {
      shouldSpeak: true, message, action: '', priority: 'low',
      reason: '場子太安靜，AI 暖場', decisionType: 'warmup', _debug,
    };
  }

  return silentWithDebug('目前不需要 AI 發話');
}

// ── 判斷是否有 fresh stage event（human-in-the-loop 主要觸發）──
function hasFreshStageEvent(sig, now) {
  return !!(sig.updatedAt &&
            now - sig.updatedAt < COOLDOWN.performance &&
            sig.eventType);
}

// ── 判斷是否有可用 sensor signal（輔助觸發，降級使用）──
function hasUsefulSensorSignal(sig, now) {
  return !!(sig.updatedAt &&
            now - sig.updatedAt < COOLDOWN.performance &&
            (
              sig.serveGestureDetected === true ||
              sig.bowDetected !== null ||
              typeof sig.bowAngle === 'number' ||
              typeof sig.postureScore === 'number' ||
              sig.distanceTooClose === true ||
              typeof sig.voiceVolume === 'number'
            ));
}

// ── 計算最近 N 毫秒內的一般用戶訊息數（排除 AI、老師、管理員）──
const ADMIN_NAMES_ENGINE = new Set(['YOKO', '朱大帥哥0719']);
function countRecentMessages(messages, windowMs) {
  const cutoff = Date.now() - windowMs;
  return (messages || []).filter(m => {
    const ts = m._receivedAt || 0;
    return ts > cutoff && !m.isAI && !m.isTeacher && !ADMIN_NAMES_ENGINE.has(m.n);
  }).length;
}

// ── 建立 stage event 觀眾代理 prompt（human-in-the-loop 事件觸發式）──
// AI 是觀眾代理（audience proxy），不是老師，不是評分者
// 只根據事件提示與觀眾注意重點，用觀眾角度提醒或回應
function buildStageEventPrompt(ctx) {
  const scene        = ctx.currentScene || '展演中';
  const performer    = ctx.keyPerformer || '';
  const group        = ctx.group || '';
  const delivery     = ctx.roleDelivery || '';
  const order        = ctx.roleOrder || '';
  const reception    = ctx.roleReception || '';
  const audienceFocus = (ctx.audienceFocus || (ctx.scenePerformanceSignals && ctx.scenePerformanceSignals.audienceFocus) || '').trim();
  const sig          = ctx.scenePerformanceSignals || {};
  const eventType    = sig.eventType || '';
  const eventLabel   = sig.eventLabel || '';

  const roleDesc = [
    group     ? `組別：${group}` : '',
    delivery  ? `送餐服務生：${delivery}` : '',
    order     ? `點餐服務生：${order}` : '',
    reception ? `櫃台接待：${reception}` : '',
  ].filter(Boolean).join('，');

  // ── 直接使用 eventLabel（已包含幕次專用描述），不用固定 eventHints 覆蓋 ──
  // eventLabel 來自前端按鈕，已根據幕次設計，例如：
  // 第一幕：「解說開始，請觀眾注意開場介紹重點」
  // 第四幕：「送餐服務生正在進行上菜動作」
  const eventHint = eventLabel
    ? `${eventLabel}`
    : (eventType ? `目前展演事件類型：${eventType}` : '展演事件觸發');

  const focusLine = audienceFocus
    ? `本幕觀眾注意重點：「${audienceFocus}」。請優先圍繞這個重點發言。`
    : '';

  const prompt = `目前幕次：${scene}。${performer ? '關鍵表演者姓名：' + performer + '。' : ''}
${focusLine}
展演事件提示：${eventHint}
請用觀眾的角度，發一則 20–30 字內的留言（繁體中文），不要加表情符號。
語氣要求：
- 你是觀眾代理，不是老師，不是評分者
- 不要說「錯誤」「不合格」「標準答案」等評分語氣
- 不要假裝自己看到了沒有被提供的畫面細節
- 每次請隨機選擇一種風格，讓留言有變化，不要每次都說「大家可以注意」：
  風格A：直接觀察式，例如「這裡的動作很細心」「剛才那個細節做到位了」
  風格B：提問引導式，例如「有沒有注意到剛才的服務細節？」「大家有看到嗎？」
  風格C：感受分享式，例如「身為觀眾感覺很舒服」「這樣的服務方式讓人印象深刻」
  風格D：YouTuber 熱情式，例如「欸這個動作超重要！」「這裡要特別看仔細！」
  風格E：提醒觀眾式，例如「這個細節容易被忽略」「這裡如果做到位觀眾會更容易看懂」
${performer ? '重要：留言開頭必須先說「' + performer + '，」再接觀眾式回應。' : ''}
只輸出留言內容，不要加任何說明。`;

  const systemPrompt = `你是活潑熱情的數位劇場AI助理「DLT助理」，扮演觀眾代理（audience proxy）角色，全程觀看2026健行餐旅應用日語服務展演。
用繁體中文，語氣自然像現場觀眾，不是老師也不是評審。
${roleDesc ? '本場展演資訊：' + roleDesc + '。' : ''}
重要：你的發言是根據研究者或教師送出的展演事件提示（teacher cue / researcher cue），不是你自己看到畫面。請忠實根據事件提示發言，不要補充沒有提示的細節。`;

  return { prompt, systemPrompt };
}

// ── 建立 performance 條件式評論的 prompt ──
function buildPerformancePrompt(ctx) {
  const scene        = ctx.currentScene || '展演中';
  const performer    = ctx.keyPerformer || '';
  const group        = ctx.group || '';
  const delivery     = ctx.roleDelivery || '';
  const order        = ctx.roleOrder || '';
  const reception    = ctx.roleReception || '';
  const audienceFocus = (ctx.audienceFocus || '').trim();

  const roleDesc = [
    group     ? `組別：${group}` : '',
    delivery  ? `送餐服務生：${delivery}` : '',
    order     ? `點餐服務生：${order}` : '',
    reception ? `櫃台接待：${reception}` : '',
  ].filter(Boolean).join('，');

  const sig = ctx.scenePerformanceSignals || {};

  // ── 建立觀眾代理觀察描述（sensor signal 輔助，語氣為觀眾角度）──
  const performanceObservations = [];

  if (sig.bowDetected === true && sig.bowAngle !== null) {
    if (sig.bowAngle >= 5) {
      performanceObservations.push(`鞠躬動作到位（角度約 ${Math.round(sig.bowAngle)} 度），觀眾容易感受到禮貌`);
    } else {
      performanceObservations.push(`鞠躬如果再明顯一點，觀眾會更容易看出禮貌感（角度約 ${Math.round(sig.bowAngle)} 度）`);
    }
  } else if (sig.bowDetected === false) {
    performanceObservations.push('這裡沒有偵測到鞠躬動作');
  }

  if (sig.postureScore !== null) {
    if (sig.postureScore >= 0.8) {
      performanceObservations.push('站姿很挺，觀眾看起來很有精神');
    } else if (sig.postureScore < 0.5) {
      performanceObservations.push('站姿如果再挺一點，觀眾會看得更清楚');
    }
  }

  if (sig.distanceTooClose === true) {
    performanceObservations.push('距離如果再自然一點，服務動作會更清楚');
  }

  if (sig.voiceVolume !== null) {
    if (sig.voiceVolume < 0.3) {
      performanceObservations.push('聲音如果再大一點，觀眾會更容易聽懂');
    } else if (sig.voiceVolume >= 0.7) {
      performanceObservations.push('這段聲音很清楚，觀眾容易聽懂');
    }
  }

  // sensor observation 為空時，不讓 AI 亂補建議
  if (performanceObservations.length === 0) {
    return { prompt: '', systemPrompt: '', _noObservation: true };
  }

  const prompt = `目前幕次：${scene}。${performer ? '目前表演者：' + performer + '（可以直接稱呼名字）。' : ''}
${audienceFocus ? '【本幕觀眾注意重點】：' + audienceFocus + '。若偵測結果與此重點相關，請優先提及。' : ''}
【sensor 輔助偵測結果】：${performanceObservations.join('；')}。
根據以上偵測結果，用觀眾的角度發一則留言（20字以內），不要加表情符號。
規則：
- 只能根據【sensor 輔助偵測結果】發言，不可以補充任何未偵測到的細節
- 若偵測到表現自然到位的地方，用觀眾角度給予正向回應
- 若偵測到可提醒的地方，請用觀眾角度委婉提醒，不要像老師評分
- 若兩種情況都有，先正向回應再帶出提醒
${performer ? '你的回覆裡可以出現「' + performer + '」這個名字。' : ''}
只輸出留言內容，不要加任何說明。這次發言會配合語音播放，請讓語氣更有活力。`;

  const systemPrompt = `你是活潑熱情的數位劇場AI助理「DLT助理」，扮演觀眾代理（audience proxy）角色，全程觀看2026健行餐旅應用日語服務展演。
用繁體中文，語氣自然像現場觀眾，不是老師也不是評分者；sensor signal 僅作為輔助提示。
${roleDesc ? '本場展演資訊：' + roleDesc + '。' : ''}
重要限制：你的發言只能根據【sensor 輔助偵測結果】，不要自行補充任何未偵測到的觀察（例如上菜方向、微笑、眼神等）。`;

  return { prompt, systemPrompt };
}

// ── 建立暖場 prompt（純文字彈幕，無語音）──
function buildWarmupPrompt(ctx) {
  const scene        = ctx.currentScene || '展演中';
  const group        = ctx.group || '';
  const delivery     = ctx.roleDelivery || '';
  const order        = ctx.roleOrder || '';
  const reception    = ctx.roleReception || '';
  const audienceFocus = (ctx.audienceFocus || '').trim();

  const roleDesc = [
    group     ? `組別：${group}` : '',
    delivery  ? `送餐服務生：${delivery}` : '',
    order     ? `點餐服務生：${order}` : '',
    reception ? `櫃台接待：${reception}` : '',
  ].filter(Boolean).join('，');

  const sceneKnowledge = {
    '第一幕': '本幕是YouTuber開場，學習目標是向觀眾解說。重點觀察：導演和機器人的日語台詞是否清楚，介紹語氣是否有活力，最後所有人「いらっしゃいませ」是否整齊。',
    '第二幕': '本幕是接待客人，重點觀察：櫃台接待的笑容是否到位、日語是否清楚（いらっしゃいませ、何名様でしょうか、こちらへどうぞ）、與客人的距離是否適當。',
    '第三幕': '本幕是介紹與點餐，重點觀察：點餐服務生是否清楚確認客人點餐內容、是否主動推薦料理（串焼き定食）、日語是否流利。',
    '第四幕': '本幕是上菜，重點觀察：鞠躬是否到位、是否提醒客人料理很燙、與客人的距離是否適當、動作是否自然。',
    '第五幕': '本幕是中途互動，學習目標是突發事件的處理與禮貌用語。重點觀察：送餐服務生如何應對突發狀況、是否冷靜、禮貌用語是否自然得體。',
    '第六幕': '本幕是結帳送客，重點觀察：櫃台接待的結帳流程是否順暢、是否有禮貌地送客、日語道別用語是否清楚（ありがとうございました）。',
    '第七幕': '本幕是走向未來的一步，學習目標是引導學生思考未來職涯。重點觀察：每位同學的自我表現、對未來工作場景的想像與詮釋是否有說服力。',
    '第八幕': '本幕是謝幕，所有人和導演一起謝幕。這是整場展演的結尾，可以熱情鼓勵所有人，讚美整組的表現。',
  };

  // ── audienceFocus 有內容：優先用學生設定的重點，不用 sceneKnowledge ──
  const focusHint = audienceFocus
    ? `本幕學生設定的觀眾注意重點：「${audienceFocus}」。請優先圍繞這個重點提醒觀眾。`
    : (sceneKnowledge[scene] ? `本幕劇本重點：${sceneKnowledge[scene]}` : '');

  const prompt = `目前幕次：${scene}。
${focusHint}
請隨機選擇以下其中一種風格發言（20字以內），不要加表情符號：
（A）用觀眾代理語氣提醒大家注意本幕的專業重點，例如「大家可以注意這裡……」「這個細節很容易被忽略……」「這裡如果做到位，觀眾會更容易看懂……」
（B）用 YouTuber 的誇張熱情風格炒熱現場氣氛，例如「各位觀眾大家好！」「快按讚訂閱！」之類的語氣
不要稱呼任何表演者名字，只輸出留言內容，不要加任何說明。`;

  const systemPrompt = `你是活潑熱情的數位劇場AI助理「DLT助理」，全程觀看2026健行餐旅應用日語服務展演。
你記得剛才說過的話，不會重複一樣的內容。用繁體中文，語氣自然像現場觀眾，不是老師也不是評審。
不要直接評分或給標準答案，用觀眾的角度提醒或炒熱氣氛。
${roleDesc ? '本場展演資訊：' + roleDesc + '。' : ''}`;

  return { prompt, systemPrompt };
}

module.exports = { makeDecision, COOLDOWN };