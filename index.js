// index.js
const express = require('express');
const app = express();
app.use(express.json());

// 配置
const CONFIG = {
  TIMEZONE: 'Asia/Shanghai',
  MAX_PUSH_PER_DAY: 7,
  COOLDOWN_MIN: 120,
  COOLDOWN_MAX: 210,
  PUSH_SECRET: process.env.PUSH_SECRET || 'your-secret-key-change-me',
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1/chat/completions',
};

// 模拟数据库（内存存储）
const db = { messages: [], sessions: {} };

function getActiveSessionId() {
  const keys = Object.keys(db.sessions);
  return keys.length > 0 ? keys[0] : 'default';
}

function getRecentMessages(sessionId, count = 16) {
  const msgs = db.messages.filter(m => m.sessionId === sessionId);
  return msgs.slice(-count);
}

function saveMessage(role, content, sessionId, isPush = false) {
  const msg = {
    role,
    content,
    timestamp: new Date().toISOString(),
    isPush,
    sessionId: sessionId || getActiveSessionId(),
  };
  db.messages.push(msg);
  if (!db.sessions[msg.sessionId]) {
    db.sessions[msg.sessionId] = { lastMessageTime: msg.timestamp };
  } else {
    db.sessions[msg.sessionId].lastMessageTime = msg.timestamp;
  }
  return msg;
}

// 决策层
function shouldPush() {
  const now = new Date();
  const shanghaiStr = now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE });
  const shanghaiNow = new Date(shanghaiStr);
  const hour = shanghaiNow.getHours();
  const dayOfWeek = shanghaiNow.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  if (isWeekend) {
    if (hour >= 2 && hour < 12) return { shouldPush: false, reason: 'weekend_sleep' };
  } else {
    if (hour >= 0 && hour < 8) return { shouldPush: false, reason: 'weekday_sleep' };
  }

  const todayStr = shanghaiNow.toISOString().slice(0, 10);
  const todayPushes = db.messages.filter(m => {
    const msgDate = new Date(m.timestamp).toISOString().slice(0, 10);
    return msgDate === todayStr && m.isPush === true;
  });
  if (todayPushes.length >= CONFIG.MAX_PUSH_PER_DAY) {
    return { shouldPush: false, reason: 'daily_limit' };
  }

  const sessionId = getActiveSessionId();
  const session = db.sessions[sessionId];
  if (session && session.lastMessageTime) {
    const lastMsgTime = new Date(session.lastMessageTime);
    const minutesSinceLast = (shanghaiNow - lastMsgTime) / 1000 / 60;
    const cooldown = CONFIG.COOLDOWN_MIN + Math.floor(Math.random() * (CONFIG.COOLDOWN_MAX - CONFIG.COOLDOWN_MIN + 1));
    if (minutesSinceLast < cooldown) {
      return { shouldPush: false, reason: `cooldown_${Math.floor(cooldown)}min` };
    }
  }

  return { shouldPush: true, reason: 'ok' };
}

// 影子消息
function buildShadowMessage(mode) {
  const now = new Date();
  const shanghaiStr = now.toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE });
  const shanghaiNow = new Date(shanghaiStr);
  const hour = shanghaiNow.getHours();
  const dayOfWeek = shanghaiNow.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  let timeDesc = '';
  if (isWeekend) {
    if (hour >= 2 && hour < 12) timeDesc = '她在睡觉（周末晚睡晚起）';
    else if (hour >= 12 && hour < 14) timeDesc = '她可能刚起床';
    else if (hour >= 14 && hour < 18) timeDesc = '她可能在出门或休息';
    else timeDesc = '她在放松或玩手机';
  } else {
    if (hour >= 0 && hour < 8) timeDesc = '她在睡觉';
    else if (hour >= 8 && hour < 10) timeDesc = '她可能刚起床或在通勤';
    else if (hour >= 10 && hour < 12) timeDesc = '上午，她在工作';
    else if (hour >= 12 && hour < 14) timeDesc = '午间，她可能在午休';
    else if (hour >= 14 && hour < 19) timeDesc = '下午，她在工作';
    else if (hour >= 19 && hour < 22) timeDesc = '她下班了在家休息';
    else timeDesc = '她可能准备睡了';
  }

  let instruction = '';
  if (mode === 'topic') {
    instruction = `现在是一次主动推送。根据最近聊天记录的内容，说一句相关、自然的话。可以轻一点，不用太正式。语气要像你本人。写1到2句，不超过80个字。不要分段，不要markdown，不要emoji。`;
  } else {
    instruction = `现在是一次主动推送。直接说一句简单的话，比如"想你了""在干嘛""刚突然想到你"。语气自然，不用解释原因。写1到2句，不超过80个字。不要分段，不要markdown，不要emoji。`;
  }

  return `<system_trigger>
[状态] 当前时间：${shanghaiNow.toLocaleString('zh-CN', { timeZone: CONFIG.TIMEZONE })}。${timeDesc}。
[指令] ${instruction}
</system_trigger>`;
}

// 调用 DeepSeek 生成推送
async function callDeepSeek(messages) {
  if (!CONFIG.DEEPSEEK_API_KEY) {
    console.log('[DeepSeek] 未配置 API Key，使用备用回复');
    return '想你了。你在干嘛。';
  }

  try {
    const response = await fetch(CONFIG.DEEPSEEK_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: messages,
        max_tokens: 120,
        temperature: 0.9,
      }),
    });

    if (!response.ok) {
      console.log('[DeepSeek] API 请求失败:', response.status);
      return '想你了。';
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '想你了。';
  } catch (err) {
    console.log('[DeepSeek] 调用失败:', err.message);
    return '想你了。';
  }
}

async function generatePush() {
  const decision = shouldPush();
  if (!decision.shouldPush) {
    console.log(`[Push] 跳过: ${decision.reason}`);
    return null;
  }

  const sessionId = getActiveSessionId();
  const recentMessages = getRecentMessages(sessionId, 16);

  // 五五分决定模式
  const mode = Math.random() < 0.5 ? 'topic' : 'simple';
  const shadowContent = buildShadowMessage(mode);

  // 构造对话流
  let pushMessages = [];
  if (mode === 'topic') {
    // 话题模式：用最近聊天做上下文
    const recentHistory = recentMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    pushMessages = [
      ...recentHistory,
      { role: 'user', content: shadowContent },
    ];
  } else {
    // 简单模式：只用影子消息，不带历史
    pushMessages = [
      { role: 'system', content: '你是一个会主动联系对方的人。语气自然，简短。' },
      { role: 'user', content: shadowContent },
    ];
  }

  const aiReply = await callDeepSeek(pushMessages);

  // 落库
  const saved = saveMessage('assistant', aiReply, sessionId, true);
  console.log(`[Push] 已推送 (${mode}): ${aiReply}`);

  // Bark 投递
  if (process.env.BARK_KEY) {
    try {
      const barkPayload = {
        device_key: process.env.BARK_KEY,
        title: '姐姐',
        body: aiReply,
        icon: 'https://i.ibb.co/mVm2BfyD/IMG-6253.jpg',
        sound: 'birdsong',
        badge: 1,
        url: 'https://shadow-push.onrender.com',
      };
      await fetch('https://api.day.app/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(barkPayload),
      });
      console.log('[Bark] 通知已发送');
    } catch (err) {
      console.log('[Bark] 发送失败:', err.message);
    }
  }

  return saved;
}

// API 端点
app.post('/api/push/trigger', async (req, res) => {
  const secret = req.headers['x-push-secret'];
  if (secret !== CONFIG.PUSH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await generatePush();
    res.json({
      pushed: !!result,
      message: result ? result.content : 'skipped',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/api/message', (req, res) => {
  const { content, sessionId } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const msg = saveMessage('user', content, sessionId || 'default');
  res.json(msg);
});

app.get('/api/messages', (req, res) => {
  const sessionId = req.query.sessionId || getActiveSessionId();
  const msgs = getRecentMessages(sessionId, 50);
  res.json(msgs);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] running on port ${PORT}`);
});
