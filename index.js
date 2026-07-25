 // index.js
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// 配置
const CONFIG = {
  TIMEZONE: 'Asia/Shanghai',
  MAX_PUSH_PER_DAY: 7,
  COOLDOWN_MIN: 120,
  COOLDOWN_MAX: 210,
  PUSH_SECRET: process.env.PUSH_SECRET || 'your-secret-key-change-me',
};

// Supabase 客户端
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 模拟数据库（内存存储，用于推送）
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

async function generatePush() {
  const decision = shouldPush();
  if (!decision.shouldPush) {
    console.log(`[Push] 跳过: ${decision.reason}`);
    return null;
  }

  const sessionId = getActiveSessionId();
  const recentMessages = getRecentMessages(sessionId, 16);

  const mode = Math.random() < 0.5 ? 'topic' : 'simple';
  const shadowContent = buildShadowMessage(mode);

  const fallbackReplies = [
    '想你了。',
    '在干嘛。',
    '刚突然想到你。',
    '今天怎么样？',
    '忙完没。',
    '我刚刚在想你。',
    '你那边天气好吗。',
    '晚上有空吗。',
    '我刚忙完，就想起你了。',
    '你今天好像没怎么找我。',
  ];
  const aiReply = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];

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

// ==================== 朋友圈功能 ====================

// 生成随机延迟（分钟）
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// AI 发动态（工具调用入口）
app.post('/api/moments/ai', async (req, res) => {
  const { content, context_note } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });

  const replyDueAt = new Date(Date.now() + randomDelay(8, 20) * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('moments')
    .insert({
      author: 'ai',
      content,
      context_note: context_note || null,
      reply_due_at: replyDueAt,
      reply_status: 'done',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 你发动态
app.post('/api/moments', async (req, res) => {
  const { content, images } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });

  const replyDueAt = new Date(Date.now() + randomDelay(10, 20) * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('moments')
    .insert({
      author: 'user',
      content,
      images: images || [],
      reply_due_at: replyDueAt,
      reply_status: 'pending',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 获取朋友圈列表（带惰性回复）
app.get('/api/moments', async (req, res) => {
  try {
    await processDueMoments();

    const { data, error } = await supabase
      .from('moments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });

    for (const moment of data) {
      const { data: comments } = await supabase
        .from('moment_comments')
        .select('*')
        .eq('moment_id', moment.id)
        .order('created_at', { ascending: true });
      moment.comments = comments || [];
    }

    res.json({ entries: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processDueMoments() {
  const now = new Date().toISOString();

  const { data: moments } = await supabase
    .from('moments')
    .select('*')
    .eq('reply_status', 'pending')
    .lte('reply_due_at', now)
    .limit(1);

  if (!moments || moments.length === 0) return;

  const moment = moments[0];

  const fallbackReplies = [
    '这张拍得不错。',
    '你最近好像很忙的样子。',
    '我刚刚路过一家店，想起你说过喜欢。',
    '今天天气挺好的，你出去了吗。',
    '这个我也吃过，还不错。',
  ];
  const reply = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
  const liked = Math.random() > 0.3;

  await supabase
    .from('moments')
    .update({
      liked,
      reply_content: reply,
      replied_at: new Date().toISOString(),
      reply_status: 'done',
    })
    .eq('id', moment.id);

  console.log(`[Moments] 已回复动态 ${moment.id}: ${reply}`);
}

// 你给 AI 的动态点赞
app.post('/api/moments/:id/user-like', async (req, res) => {
  const { liked } = req.body;
  const { data, error } = await supabase
    .from('moments')
    .update({ user_liked: liked === true })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 你在 AI 动态下评论
app.post('/api/moments/:id/comments', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });

  const replyDueAt = new Date(Date.now() + randomDelay(3, 8) * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('moment_comments')
    .insert({
      moment_id: req.params.id,
      author: 'user',
      content,
      reply_status: 'pending',
      reply_due_at: replyDueAt,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

async function processDueCommentReplies() {
  const now = new Date().toISOString();

  const { data: comments } = await supabase
    .from('moment_comments')
    .select('*')
    .eq('author', 'user')
    .eq('reply_status', 'pending')
    .lte('reply_due_at', now)
    .limit(1);

  if (!comments || comments.length === 0) return;

  const comment = comments[0];

  const fallbackReplies = [
    '你说得对。',
    '我其实也这么想的。',
    '好，听你的。',
    '你在哪看到的？',
    '我记住了。',
  ];
  const reply = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];

  await supabase
    .from('moment_comments')
    .insert({
      moment_id: comment.moment_id,
      author: 'ai',
      content: reply,
      reply_status: 'none',
    });

  await supabase
    .from('moment_comments')
    .update({ reply_status: 'done' })
    .eq('id', comment.id);

  console.log(`[Moments] 已回复评论 ${comment.id}: ${reply}`);
}

// ==================== 原有 API 端点 ====================

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
