import dotenv from 'dotenv';
dotenv.config();

import Redis from 'ioredis';
import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import express from 'express';

// --- CONFIGURATION ---
const {
  TELEGRAM_TOKEN,
  MONGODB_URI,
  ADMIN_IDS = '',
  DAILY_LIMIT = '100',
  RESULTS_PER_PAGE = '10',
  PORT = 3000,
  RENDER_EXTERNAL_URL,
  FORCE_CHANNEL_ID,
  STORAGE_CHANNEL_ID,
  FAV_LIMIT = '50',
  PRIVATE_AUTO_DELETE_MS = '60000',
  GROUP_AUTO_DELETE_MS = '30000',
  GROUP_COOLDOWN_MS = '10000'
} = process.env;

if (!TELEGRAM_TOKEN || !MONGODB_URI || !STORAGE_CHANNEL_ID) {
  console.error('❌ Error: Missing Token, MongoDB URI, or Storage Channel ID');
  process.exit(1);
}

const ADMIN_SET = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const DAILY_LIMIT_NUM = Number(DAILY_LIMIT);
const RESULTS_PER_PAGE_NUM = Number(RESULTS_PER_PAGE);
const FAV_LIMIT_NUM = Number(FAV_LIMIT);
const PRIVATE_DELETE_TIME = Number(PRIVATE_AUTO_DELETE_MS);
const GROUP_DELETE_TIME = Number(GROUP_AUTO_DELETE_MS);
const GROUP_COOLDOWN_TIME = Number(GROUP_COOLDOWN_MS);

// --- DATABASE CONNECT ---
const redis = new Redis(process.env.REDIS_URL);
redis.on('error', err => console.error('Redis Error:', err.message));

await mongoose.connect(MONGODB_URI, { dbName: 'TelegramMovies' });
console.log('✅ MongoDB Connected');

// --- SCHEMAS ---
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  userId: { type: String, unique: true, index: true },
  firstName: String,
  username: String,
  joinedAt: { type: Date, default: Date.now }
});

const FileSchema = new Schema({
  customId: { type: String, unique: true, index: true },
  message_id: { type: Number, required: true },
  file_name: String,
  type: String,
  file_size: String,
  clean_title: String,
  attributes: { type: [String], index: true },
  uploaded_at: { type: Date, default: Date.now, index: true },
  downloads: { type: Number, default: 0, index: true }
});

const CounterSchema = new Schema({ _id: String, seq: Number });
const LimitSchema = new Schema({ userId: String, date: String, count: { type: Number, default: 0 } });
const FavoriteSchema = new Schema({ userId: String, customId: String, savedAt: { type: Date, default: Date.now } });

LimitSchema.index({ userId: 1, date: 1 }, { unique: true });
FavoriteSchema.index({ userId: 1, customId: 1 }, { unique: true });

const User = mongoose.model('User', UserSchema);
const File = mongoose.model('File', FileSchema);
const Counter = mongoose.model('Counter', CounterSchema);
const Limit = mongoose.model('Limit', LimitSchema);
const Favorite = mongoose.model('Favorite', FavoriteSchema);

// --- HELPERS ---

function autoDeleteMessage(bot, chatId, messageId, delayMs = 60000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch(() => { });
  }, delayMs);
}

async function nextSequence(name = 'file') {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  ).lean();
  return 'F' + String(doc.seq).padStart(4, '0');
}

async function incrementAndGetLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await Limit.findOneAndUpdate(
    { userId, date: today },
    { $inc: { count: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return doc.count;
}

async function getUserLimitCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await Limit.findOne({ userId, date: today }).lean();
  return doc?.count || 0;
}

async function saveUser(msg) {
  if (!msg.from || msg.from.is_bot) return;
  const userId = String(msg.from.id);
  try {
    await User.updateOne(
      { userId },
      { $set: { firstName: msg.from.first_name, username: msg.from.username }, $setOnInsert: { joinedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) { }
}

async function verifyJoin(chatId, userId, fileCode = null) {
  if (!FORCE_CHANNEL_ID) return true;
  if (ADMIN_SET.has(userId)) return true;

  const cacheKey = `isMember:${userId}`;
  const cached = await redis.get(cacheKey);

  // 👇 FIX 1: Only return early if they ARE a member. 
  // If cache says 'false', we ignore it and proceed to send the message.
  if (cached === 'true') return true;

  try {
    const member = await bot.getChatMember(FORCE_CHANNEL_ID, userId);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status);

    // 👇 FIX 2: Only save to Redis if they ARE a member.
    // We do NOT save 'false' anymore. This ensures non-members always get the warning.
    if (isMember) {
      await redis.set(cacheKey, 'true', 'EX', 300); // Remember 'true' for 5 mins
      return true;
    }

    // --- If we are here, the user is NOT a member ---
    
    // Generate Invite Link
    let channelLink = 'https://t.me/';
    if (FORCE_CHANNEL_ID.startsWith('@')) {
      channelLink = `https://t.me/${FORCE_CHANNEL_ID.replace('@', '')}`;
    } else {
      try { channelLink = await bot.exportChatInviteLink(FORCE_CHANNEL_ID); } catch (e) {}
    }

    // Create Button (with hidden file code)
    const callbackData = fileCode ? `CHECK_JOIN:${fileCode}` : 'CHECK_JOIN';

    await bot.sendMessage(chatId, '⚠️ <b>You must join our channel to use this bot.</b>', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Join Channel', url: channelLink }],
          [{ text: '✅ I Have Joined', callback_data: callbackData }]
        ]
      }
    });
    return false;

  } catch (err) { 
    console.error('Force Join Error:', err.message);
    return true; // If bot crashes (e.g. not admin), let the user pass
  }
}

async function checkGroupCooldown(chatId) {
  const key = `group_cooldown:${chatId}`;
  const exists = await redis.get(key);
  if (exists) return false;
  await redis.set(key, '1', 'PX', GROUP_COOLDOWN_TIME);
  return true;
}

async function cacheSearchResults(userId, fileIds) {
  const key = `search_res:${userId}`;
  await redis.del(key);
  if (fileIds.length > 0) {
    await redis.rpush(key, ...fileIds);
    await redis.expire(key, 600);
  }
}

async function getCachedPage(userId, page) {
  const start = page * RESULTS_PER_PAGE_NUM;
  const end = start + RESULTS_PER_PAGE_NUM - 1;
  const key = `search_res:${userId}`;
  const total = await redis.llen(key);
  const ids = await redis.lrange(key, start, end);
  return { ids, total };
}

function cleanFileName(text) {
  return text.replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)$/i, '')
    .replace(/@\w+/g, '')
    .replace(/[\[\]\(\)\{\}\.\;\:\~\|\,\_\-\+]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(1) + " KB";
}

// --- SERVER ---
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Bot is running. 🚀'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// --- [FIX] SET COMMAND MENU (No /help here) ---
bot.setMyCommands([
  { command: '/start', description: 'Restart Bot' },
  { command: '/recent', description: 'New Uploads' },
  { command: '/trending', description: 'Popular Files' },
  { command: '/favorites', description: 'My Saved Files' },
  { command: '/myaccount', description: 'Check Limit' },
]).catch(() => { });


// --- INDEXING ---
bot.on('channel_post', async (msg) => {
  if (String(msg.chat.id) !== STORAGE_CHANNEL_ID) return;
  const file = msg.video || msg.document;
  if (!file) return;

  try {
    const rawName = msg.caption || file.file_name || "Unknown";
    const clean = cleanFileName(rawName);
    const size = formatSize(file.file_size);
    const customId = await nextSequence();

    await File.create({
      customId,
      message_id: msg.message_id,
      file_name: rawName,
      type: msg.video ? 'video' : 'document',
      file_size: size,
      clean_title: clean,
      attributes: clean.toLowerCase().split(' ').filter(t => t.length > 0)
    });

    const newCaption = `${msg.caption || ''}\n\n✅ <b>Indexed:</b> ${customId}`;
    await bot.editMessageCaption(newCaption, { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' }).catch(() => { });
  } catch (err) { console.error('Index Error:', err); }
});

// --- COMMANDS ---

// 1. /start (Fixed Logic)
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = String(msg.from.id);
  const startParam = match[1];

  await saveUser(msg);

  if (msg.chat.type !== 'private') {
    // If it's a deep link (e.g. /start F0001), ignore it (buttons handle this)
    if (startParam) return; 

    // If plain /start, show a "Go to Private" button
    const botUsername = (await bot.getMe()).username;
    const sent = await bot.sendMessage(chatId, `👋 <b>Hello! I work in Private Chat.</b>\nClick below to start:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🤖 Start Me', url: `https://t.me/${botUsername}` }]] }
    });
    // Delete this message after 10 seconds
    return autoDeleteMessage(bot, chatId, sent.message_id, 10000);
  }

  // A. Deep Link Handling
  if (startParam && /^F\d{4}$/i.test(startParam)) {
    if (msg.chat.type !== 'private') return;
    if (!await verifyJoin(chatId, fromId)) return;

    const customId = startParam.toUpperCase();
    const file = await File.findOne({ customId }).lean();
    if (!file) return bot.sendMessage(chatId, '❌ File not found.');

    if ((await getUserLimitCount(fromId)) >= DAILY_LIMIT_NUM) return bot.sendMessage(chatId, '⚠️ Daily limit reached.');

    await incrementAndGetLimit(fromId);
    await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });

    const sent = await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, file.message_id, {
      caption: `🎬 <b>${file.clean_title}</b>\n📦 ${file.file_size}\n🆔 <code>${file.customId}</code>\n\n⚠️ <i>Auto-deletes in ${PRIVATE_DELETE_TIME / 1000}s</i>`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '❤️ Favorite', callback_data: `FAV:${file.customId}` }]] }
    });
    autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
    return;
  }

  // B. Standard Welcome
  if (msg.chat.type === 'private') {
    if (!await verifyJoin(chatId, fromId)) return;
    bot.sendMessage(chatId, `👋 <b>Welcome!</b>\n\nType a movie name to search.\nUse /help to see how to use.`, { parse_mode: 'HTML' });
  }
});

// 2. /help (Smart Help)
bot.onText(/\/help/, async (msg) => {
  if (msg.chat.type !== 'private') return; // Ignore in groups

  const isAdmin = ADMIN_SET.has(String(msg.from.id));

  let text = `📚 <b>Help Guide</b>\n\n🔎 <b>Search:</b> Just type the movie name.\n❤️ <b>Favorites:</b> Save files for later.\n📊 <b>Trending:</b> See what's popular.`;

  if (isAdmin) {
    text += `\n\n👮‍♂️ <b>Admin Commands:</b>\n/stats - Check users\n/broadcast - Message all\n/delete [ID] - Remove file`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// 3. /trending (Auto-Delete Fix + Group Size Fix)
bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';
  const botUsername = (await bot.getMe()).username;

  if (isGroup && !await checkGroupCooldown(chatId)) return;

  const files = await File.find().sort({ downloads: -1 }).limit(10).lean();
  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No trending files yet.');
    return autoDeleteMessage(bot, chatId, sent.message_id, 5000);
  }

  if (isGroup) {
    // [FIX] Added File Size to Group Button
    const keyboard = files.map(f => [{ text: `📥 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${botUsername}?start=${f.customId}` }]);
    const sent = await bot.sendMessage(chatId, '📈 <b>Top Trending:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    autoDeleteMessage(bot, chatId, sent.message_id, GROUP_DELETE_TIME);
  } else {
    const keyboard = files.map(f => [{ text: `🔥 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);
    const sent = await bot.sendMessage(chatId, '📈 <b>Top Trending:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    // [FIX] Added Auto-Delete for Private
    autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
  }
});

// 4. /recent (Auto-Delete Fix + Group Size Fix)
bot.onText(/\/recent/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';
  const botUsername = (await bot.getMe()).username;

  if (isGroup && !await checkGroupCooldown(chatId)) return;

  const files = await File.find().sort({ uploaded_at: -1 }).limit(10).lean();
  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No recent files.');
    return autoDeleteMessage(bot, chatId, sent.message_id, 5000);
  }

  if (isGroup) {
    // [FIX] Added File Size to Group Button
    const keyboard = files.map(f => [{ text: `🆕 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${botUsername}?start=${f.customId}` }]);
    const sent = await bot.sendMessage(chatId, '🆕 <b>Recent Uploads:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    autoDeleteMessage(bot, chatId, sent.message_id, GROUP_DELETE_TIME);
  } else {
    const keyboard = files.map(f => [{ text: `📂 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);
    const sent = await bot.sendMessage(chatId, '🆕 <b>Recent Uploads:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    // [FIX] Added Auto-Delete for Private
    autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
  }
});

// 5. /favorites & /myaccount (Silent in Groups)
bot.onText(/\/favorites|\/myaccount/, async (msg) => {

  if (msg.chat.type !== 'private') {
    const botUsername = (await bot.getMe()).username;
    const sent = await bot.sendMessage(msg.chat.id, `⚠️ <b>This command is for Private Chat only!</b>`, { 
      parse_mode: 'HTML', 
      reply_markup: { inline_keyboard: [[{ text: '🤖 Open Private Chat', url: `https://t.me/${botUsername}` }]] }
    });
    // Delete after 10 seconds
    return autoDeleteMessage(bot, msg.chat.id, sent.message_id, 10000);
  }

  if (msg.text.includes('myaccount')) {
    const used = await getUserLimitCount(String(msg.from.id));
    const sent = await bot.sendMessage(msg.chat.id, `👤 <b>Account</b>\nUsed: ${used}/${DAILY_LIMIT_NUM}\nLimit Resets Daily`, { parse_mode: 'HTML' });
    return autoDeleteMessage(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
  }

  const favs = await Favorite.find({ userId: String(msg.from.id) }).lean();
  if (!favs.length) {
    const sent = await bot.sendMessage(msg.chat.id, 'No favorites saved.');
    return autoDeleteMessage(bot, msg.chat.id, sent.message_id, 5000);
  }

  const files = await File.find({ customId: { $in: favs.map(f => f.customId) } }).lean();
  const keyboard = files.map(f => [{ text: `⭐ ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);
  const sent = await bot.sendMessage(msg.chat.id, `❤️ <b>Your Favorites:</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  autoDeleteMessage(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
});

// --- MAIN MESSAGE LOGIC ---
bot.on('message', async (msg) => {
  if (msg.new_chat_members) {
    const me = await bot.getMe();
    const isMe = msg.new_chat_members.find(m => m.username === me.username);
    if (isMe) {
      return bot.sendMessage(msg.chat.id,
        `👋 <b>Thanks for adding me!</b>\nJust type a movie name, and I'll find it for you.`,
        { parse_mode: 'HTML' }
      );
    }
  }

  if (!msg.text || msg.text.startsWith('/') || msg.from.is_bot || msg.chat.type === 'channel') return;

  const chatId = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';
  const text = msg.text.trim();

  // GROUP SEARCH
  if (isGroup) {
    if (!await checkGroupCooldown(chatId)) return;
    const keywords = text.toLowerCase().split(' ').filter(Boolean);
    const files = await File.find({ attributes: { $all: keywords } }).limit(5).lean();

    if (files.length > 0) {
      const botUsername = (await bot.getMe()).username;
      // [FIX] Added File Size to Group Button
      const keyboard = files.map(f => [{ text: `📥 ${f.file_size} | ${f.clean_title}`, url: `https://t.me/${botUsername}?start=${f.customId}` }]);
      const sent = await bot.sendMessage(chatId, `🔍 <b>Found ${files.length} results:</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      autoDeleteMessage(bot, chatId, sent.message_id, GROUP_DELETE_TIME);
    } else {
      const sent = await bot.sendMessage(chatId, `🤷‍♂️ <b>Could not find "${text}"</b>\nTry checking the spelling.`, { parse_mode: 'HTML' });
      // Delete this warning after 5 seconds to keep group clean
      autoDeleteMessage(bot, chatId, sent.message_id, 5000);
    }
    return;
  }

  // PRIVATE SEARCH
  if (!isGroup) {
    await saveUser(msg);
    if (!await verifyJoin(chatId, String(msg.from.id))) return;

    const keywords = text.toLowerCase().split(' ').filter(Boolean);
    const allMatches = await File.find({ attributes: { $all: keywords } })
      .select('customId')
      .sort({ uploaded_at: -1 })
      .limit(100)
      .lean();

    if (!allMatches.length) {
      const sent = await bot.sendMessage(chatId, '🔍 No results.');
      // [FIX] Added Delay to "No Results" message
      return autoDeleteMessage(bot, chatId, sent.message_id, 3000);
    }

    const fileIds = allMatches.map(f => f.customId);
    await cacheSearchResults(String(msg.from.id), fileIds);

    const { ids, total } = await getCachedPage(String(msg.from.id), 0);
    const files = await File.find({ customId: { $in: ids } }).sort({ uploaded_at: -1 }).lean();

    const keyboard = files.map(f => [{ text: `📂 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);
    if (total > RESULTS_PER_PAGE_NUM) keyboard.push([{ text: `Page 1 of ${Math.ceil(total / RESULTS_PER_PAGE_NUM)} ➡️`, callback_data: `PAGE:1` }]);

    const sent = await bot.sendMessage(chatId, `🔍 Found <b>${total}</b> files:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });

    // [FIX] Instant Delete Solved: Added PRIVATE_DELETE_TIME
    autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
  }
});

// --- CALLBACKS ---
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const fromId = String(q.from.id);
  const data = q.data;

  if (data === 'CHECK_JOIN') {
    await redis.del(`isMember:${fromId}`);
    if (await verifyJoin(chatId, fromId)) {
      bot.sendMessage(chatId, '✅ Thanks! You can now search.');
      bot.deleteMessage(chatId, q.message.message_id).catch(() => { });
    } else {
      bot.answerCallbackQuery(q.id, { text: '❌ Not joined!', show_alert: true });
    }
    return;
  }

  if (!await verifyJoin(chatId, fromId)) return bot.answerCallbackQuery(q.id, { text: 'Join channel first!' });

  try {
    if (data.startsWith('PAGE:')) {
      const page = Number(data.split(':')[1]);
      const { ids, total } = await getCachedPage(fromId, page);

      if (!ids.length) return bot.answerCallbackQuery(q.id, { text: 'Search expired.' });

      const files = await File.find({ customId: { $in: ids } }).sort({ uploaded_at: -1 }).lean();
      const keyboard = files.map(f => [{ text: `📂 ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);

      const nav = [];
      if (page > 0) nav.push({ text: '⬅️', callback_data: `PAGE:${page - 1}` });
      if ((page + 1) * RESULTS_PER_PAGE_NUM < total) nav.push({ text: '➡️', callback_data: `PAGE:${page + 1}` });
      if (nav.length) keyboard.push(nav);

      await bot.editMessageText(`🔍 Results (Page ${page + 1})`, {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    if (data.startsWith('GET:')) {
      const customId = data.split(':')[1];
      const file = await File.findOne({ customId }).lean();
      if (!file) return bot.answerCallbackQuery(q.id, { text: 'File deleted.' });

      if ((await getUserLimitCount(fromId)) >= DAILY_LIMIT_NUM) return bot.answerCallbackQuery(q.id, { text: 'Limit Exceeded!', show_alert: true });

      await bot.answerCallbackQuery(q.id, { text: 'Sending...' });
      await incrementAndGetLimit(fromId);
      await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });

      const sent = await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, file.message_id, {
        caption: `🎬 <b>${file.clean_title}</b>\n📦 ${file.file_size}\n🆔 <code>${file.customId}</code>\n\n⚠️ <i>Auto-deletes in ${PRIVATE_DELETE_TIME / 1000}s</i>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '❤️ Favorite', callback_data: `FAV:${file.customId}` }]] }
      });
      autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
      return;
    }

    if (data.startsWith('FAV:')) {
      const customId = data.split(':')[1];
      const exists = await Favorite.findOne({ userId: fromId, customId });

      if (exists) {
        await Favorite.deleteOne({ userId: fromId, customId });
        bot.answerCallbackQuery(q.id, { text: 'Removed' });
      } else {
        const count = await Favorite.countDocuments({ userId: fromId });
        if (count >= FAV_LIMIT_NUM) return bot.answerCallbackQuery(q.id, { text: `Max ${FAV_LIMIT_NUM} favorites allowed.` });

        await Favorite.create({ userId: fromId, customId });
        bot.answerCallbackQuery(q.id, { text: 'Saved' });
      }
    }
  } catch (e) { console.error(e); }
});

process.on('SIGINT', async () => { await mongoose.disconnect(); process.exit(0); });