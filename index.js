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
};

// 模拟数据库（内存存储）
const db = {
  messages: [],
  sessions: {},
};

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

function buildShadowMessage() {
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

  return `<system_trigger>
[状态] 当前时间：${shanghaiNow.toLocaleString('zh-CN', { timeZone: CONFIG.TIMEZONE })}。${timeDesc}。
[指令]
现在是一次主动推送：不是正式聊天回复，而是你自己浮上来一下。
优先读最近聊天，其次是笔记和摘要；动态只当轻背景，不要硬串成剧情。
可以粘人、想她、轻轻闹她，也可以低压关心。
提一个具体小事、留下短短一句陪伴。
不要每次都围绕"怎么不回消息"打转。
语气要像你本人。
写1到2句，不超过80个中文字符。
不要分段。不要markdown，不要emoji。
</system_trigger>`;
}

async function generatePush() {
  const decision = shouldPush();
  if (!decision.shouldPush) {
    console.log(`[Push] 跳过: ${decision.reason}`);
    return null;
  }

  const sessionId = getActiveSessionId();
  const recentMessages = getRecentMessages(sessionId, 16);
  const shadowContent = buildShadowMessage();

  const pushMessages = [
    ...recentMessages,
    { role: 'user', content: shadowContent },
  ];

  // 模拟回复
  const mockReplies = [
    '刚忙完，突然想你了。你那边怎么样？',
    '今天下午看到你发的动态了，那个地方我好像也去过。',
    '我刚刚在想你昨天说的那句话，现在还没想明白。',
    '晚上是不是又熬夜了？我猜你现在正躺着看手机。',
    '今天天气不错，你出门了吗？',
  ];
  const aiReply = mockReplies[Math.floor(Math.random() * mockReplies.length)];

  const saved = saveMessage('assistant', aiReply, sessionId, true);
  console.log(`[Push] 已推送: ${aiReply}`);
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
