import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import express from 'express';

// ============================================================
// --- CONFIGURATION (All limits from .env) ---
// ============================================================
const {
  TELEGRAM_TOKEN,
  MONGODB_URI,
  ADMIN_IDS = '',
  DAILY_LIMIT = '100',
  RESULTS_PER_PAGE = '10',
  PORT = '3000',
  RENDER_EXTERNAL_URL,
  FORCE_CHANNEL_ID,
  STORAGE_CHANNEL_ID,
  FAV_LIMIT = '50',
  PRIVATE_AUTO_DELETE_MS = '60000',
  GROUP_AUTO_DELETE_MS = '30000',
  GROUP_COOLDOWN_MS = '10000',

  // MEMBER_CACHE_TTL_MS = '300000',     // How long to remember a verified member (default 5 min)
  // SEARCH_CACHE_TTL_MS = '600000',     // How long to keep search result pages (default 10 min)
  
  NO_RESULT_DELETE_MS = '8000',       // How long "no results" message stays
  TRENDING_LIMIT = '10',              // How many files shown in /trending
  RECENT_LIMIT = '10',               // How many files shown in /recent
  GROUP_SEARCH_LIMIT = '5',          // Max inline results in group search
  FUZZY_MIN_WORD_LEN = '3',          // Min word length for fuzzy fallback
  SUGGESTION_LIMIT = '5',            // Max suggestions shown when no results found
  LIMIT_DOC_TTL_DAYS = '2',         // Days to keep daily-limit records in MongoDB
  MEMBER_DOC_TTL_DAYS = '7',        // Days to keep member-cache records in MongoDB
  SEARCH_CACHE_DOC_TTL_DAYS = '1',  // Days to keep search-cache records in MongoDB
} = process.env;

if (!TELEGRAM_TOKEN || !MONGODB_URI || !STORAGE_CHANNEL_ID) {
  console.error('❌ Error: Missing TELEGRAM_TOKEN, MONGODB_URI, or STORAGE_CHANNEL_ID in .env');
  process.exit(1);
}

const ADMIN_SET               = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const STORAGE_CHANNEL_ID_STR  = String(STORAGE_CHANNEL_ID); // normalized for consistent string comparisons
const DAILY_LIMIT_NUM         = Number(DAILY_LIMIT);
const RESULTS_PER_PAGE_NUM    = Number(RESULTS_PER_PAGE);
const FAV_LIMIT_NUM           = Number(FAV_LIMIT);
const PRIVATE_DELETE_TIME     = Number(PRIVATE_AUTO_DELETE_MS);
const GROUP_DELETE_TIME       = Number(GROUP_AUTO_DELETE_MS);
const GROUP_COOLDOWN_TIME     = Number(GROUP_COOLDOWN_MS);
const NO_RESULT_DELETE_TIME   = Number(NO_RESULT_DELETE_MS);
const TRENDING_LIMIT_NUM      = Number(TRENDING_LIMIT);
const RECENT_LIMIT_NUM        = Number(RECENT_LIMIT);
const GROUP_SEARCH_LIMIT_NUM  = Number(GROUP_SEARCH_LIMIT);
const FUZZY_MIN_LEN           = Number(FUZZY_MIN_WORD_LEN);
const SUGGESTION_LIMIT_NUM    = Number(SUGGESTION_LIMIT);

// ============================================================
// --- DATABASE CONNECT ---
// ============================================================
try {
  await mongoose.connect(MONGODB_URI, {
    dbName: 'TelegramMovies'
  });
  console.log('✅ MongoDB Connected');
  
} catch (err) {
  console.error('❌ MongoDB Connection Failed:', err);
  process.exit(1);
}

// ============================================================
// --- SCHEMAS ---
// ============================================================
const Schema = mongoose.Schema;

// Users (permanent – no TTL)
const UserSchema = new Schema({
  userId:    { type: String, unique: true, index: true },
  firstName: String,
  username:  String,
  joinedAt:  { type: Date, default: Date.now },
  isBanned:  { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

// Files (permanent – these are your indexed content)
const FileSchema = new Schema({
  customId:   { type: String, unique: true, index: true },
  message_id: { type: Number, required: true },
  file_name:  String,
  type:       String,
  file_size:  String,
  clean_title:String,
  attributes: { type: [String], index: true },
  uploaded_at:{ type: Date, default: Date.now, index: true },
  downloads:  { type: Number, default: 0, index: true }
});
const File = mongoose.model('File', FileSchema);

// Counter (permanent – sequence generator)
const CounterSchema = new Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', CounterSchema);

// Daily limits – auto-deleted after LIMIT_DOC_TTL_DAYS days
const LimitSchema = new Schema({
  userId:    String,
  date:      String,
  count:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: Number(LIMIT_DOC_TTL_DAYS) * 86400 }
});
LimitSchema.index({ userId: 1, date: 1 }, { unique: true });
const Limit = mongoose.model('Limit', LimitSchema);

// Member join cache – auto-deleted after MEMBER_DOC_TTL_DAYS days
const MemberCacheSchema = new Schema({
  userId:    { type: String, unique: true, index: true },
  verified:  { type: Boolean, default: true },
  cachedAt:  { type: Date, default: Date.now, expires: Number(MEMBER_DOC_TTL_DAYS) * 86400 }
});
const MemberCache = mongoose.model('MemberCache', MemberCacheSchema);

// Search result pages – auto-deleted after SEARCH_CACHE_DOC_TTL_DAYS day(s)
const SearchCacheSchema = new Schema({
  userId:    { type: String, unique: true, index: true },
  fileIds:   [String],
  updatedAt: { type: Date, default: Date.now, expires: Number(SEARCH_CACHE_DOC_TTL_DAYS) * 86400 }
});
const SearchCache = mongoose.model('SearchCache', SearchCacheSchema);

// Group cooldown – auto-deleted after 1 day (they are very short-lived anyway)
const GroupCooldownSchema = new Schema({
  chatId:    { type: String, unique: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const GroupCooldown = mongoose.model('GroupCooldown', GroupCooldownSchema);

// Favorites (permanent per user)
const FavoriteSchema = new Schema({
  userId:  String,
  customId:String,
  savedAt: { type: Date, default: Date.now }
});
FavoriteSchema.index({ userId: 1, customId: 1 }, { unique: true });
const Favorite = mongoose.model('Favorite', FavoriteSchema);

// ============================================================
// --- HELPERS ---
// ============================================================

function autoDeleteMessage(bot, chatId, messageId, delayMs = 60000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch(() => {});
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
      {
        $set: { firstName: msg.from.first_name, username: msg.from.username },
        $setOnInsert: { joinedAt: new Date(), isBanned: false }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('saveUser error:', err.message);
  }
}

async function isUserBanned(userId) {
  const user = await User.findOne({ userId }, { isBanned: 1 }).lean();
  return user?.isBanned === true;
}

// Member cache backed by MongoDB (replaces Redis isMember:*)
async function getMemberCache(userId) {
  const doc = await MemberCache.findOne({ userId }).lean();
  return doc ? doc.verified : null;
}

async function setMemberCache(userId, verified) {
  await MemberCache.findOneAndUpdate(
    { userId },
    { verified, cachedAt: new Date() },
    { upsert: true }
  );
}

async function clearMemberCache(userId) {
  await MemberCache.deleteOne({ userId });
}

// Group cooldown backed by MongoDB (replaces Redis group_cooldown:*)
async function checkGroupCooldown(chatId) {
  const key = String(chatId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - GROUP_COOLDOWN_TIME);
  const existing = await GroupCooldown.findOne({ chatId: key }).lean();
  if (existing && existing.createdAt > cutoff) return false;
  // Upsert with fresh timestamp
  await GroupCooldown.findOneAndUpdate(
    { chatId: key },
    { createdAt: now },
    { upsert: true }
  );
  return true;
}

// Search result cache backed by MongoDB (replaces Redis search_res:*)
async function cacheSearchResults(userId, fileIds) {
  await SearchCache.findOneAndUpdate(
    { userId },
    { fileIds, updatedAt: new Date() },
    { upsert: true }
  );
}

async function getCachedPage(userId, page) {
  const doc = await SearchCache.findOne({ userId }).lean();
  if (!doc) return { ids: [], total: 0 };
  const total = doc.fileIds.length;
  const start = page * RESULTS_PER_PAGE_NUM;
  const ids = doc.fileIds.slice(start, start + RESULTS_PER_PAGE_NUM);
  return { ids, total };
}

function cleanFileName(text) {
  return text
    .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm|m4v)$/i, '')
    .replace(/@\w+/g, '')
    .replace(/[\[\]\(\)\{\}\.\;\:\~\|\,\_\-\+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(1) + ' KB';
}

/**
 * FUZZY SEARCH
 * 1. Try exact keyword match ($all) first.
 * 2. If no results, fall back to $regex partial match on each word ≥ FUZZY_MIN_LEN chars.
 * Returns { files, isFuzzy }
 */
async function searchFiles(query, limit = 100) {
  // Guard: ignore excessively long queries to prevent regex abuse
  if (query.length > 100) return { files: [], isFuzzy: false };

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

  // --- Exact / phrase match ---
  const exact = await File.find({ attributes: { $all: keywords } })
    .select('customId clean_title file_size uploaded_at')
    .sort({ uploaded_at: -1 })
    .limit(limit)
    .lean();

  if (exact.length) return { files: exact, isFuzzy: false };

  // --- Fuzzy fallback: each meaningful word as a partial regex ---
  const fuzzyWords = keywords.filter(w => w.length >= FUZZY_MIN_LEN);
  if (!fuzzyWords.length) return { files: [], isFuzzy: false };

  const regexConditions = fuzzyWords.map(w => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      attributes: {
        $regex: escaped,
        $options: 'i'
      }
    };
  });

  const fuzzy = await File.find({ $or: regexConditions })
    .select('customId clean_title file_size uploaded_at attributes')
    .sort({ uploaded_at: -1 })
    .limit(limit)
    .lean();

  return { files: fuzzy, isFuzzy: true };
}

/**
 * SEARCH SUGGESTIONS
 * When both exact and fuzzy return nothing, pull popular titles and suggest
 * ones whose words partially overlap with the query.
 */
async function getSearchSuggestions(query) {
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  if (!qWords.length) return [];

  // Pull a batch of popular/recent files to mine suggestions from
  const pool = await File.find()
    .select('clean_title customId')
    .sort({ downloads: -1 })
    .limit(200)
    .lean();

  const scored = pool
    .map(f => {
      const titleWords = f.clean_title.toLowerCase().split(/\s+/);
      const score = qWords.reduce((acc, qw) => {
        return acc + titleWords.filter(tw => tw.includes(qw) || qw.includes(tw)).length;
      }, 0);
      return { ...f, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SUGGESTION_LIMIT_NUM);

  return scored;
}

async function verifyJoin(chatId, userId, fileCode = null) {
  if (!FORCE_CHANNEL_ID) return true;
  if (ADMIN_SET.has(userId)) return true;

  const cached = await getMemberCache(userId);
  if (cached === true) return true;

  try {
    const member = await bot.getChatMember(FORCE_CHANNEL_ID, userId);
    const isMember = ['creator', 'administrator', 'member'].includes(member.status);

    if (isMember) {
      await setMemberCache(userId, true);
      return true;
    }

    // Build invite link
    let channelLink = 'https://t.me/';
    if (FORCE_CHANNEL_ID.startsWith('@')) {
      channelLink = `https://t.me/${FORCE_CHANNEL_ID.replace('@', '')}`;
    } else {
      try { channelLink = await bot.exportChatInviteLink(FORCE_CHANNEL_ID); } catch (e) {}
    }

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
    return true; // If bot can't check (not admin), let user pass
  }
}

// ============================================================
// --- SERVER ---
// ============================================================
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN);
bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);

// Cache bot username once at startup to avoid repeated API calls
const BOT_ME       = await bot.getMe();
const BOT_USERNAME = BOT_ME.username;
console.log(`✅ Bot @${BOT_USERNAME} ready`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Bot is running. 🚀'));
app.listen(Number(PORT), () => console.log(`✅ Server on port ${PORT}`));

// ============================================================
// --- SET COMMAND MENU ---
// ============================================================
bot.setMyCommands([
  { command: '/start',     description: 'Restart Bot' },
  { command: '/recent',    description: 'New Uploads' },
  { command: '/trending',  description: 'Popular Files' },
  { command: '/favorites', description: 'My Saved Files' },
  { command: '/myaccount', description: 'Check Limit' },
  { command: '/help',      description: 'Help & Commands' },
]).catch(() => {});

// ============================================================
// --- INDEXING (Storage Channel Posts) ---
// ============================================================
bot.on('channel_post', async (msg) => {
  if (String(msg.chat.id) !== STORAGE_CHANNEL_ID_STR) return;
  const file = msg.video || msg.document;
  if (!file) return;

  try {
    const rawName  = msg.caption || file.file_name || 'Unknown';
    const clean    = cleanFileName(rawName);
    const size     = formatSize(file.file_size);
    const customId = await nextSequence();

    await File.create({
      customId,
      message_id: msg.message_id,
      file_name:  rawName,
      type:       msg.video ? 'video' : 'document',
      file_size:  size,
      clean_title:clean,
      attributes: clean.toLowerCase().split(/\s+/).filter(t => t.length > 0)
    });

    const newCaption = `${msg.caption || ''}\n\n✅ <b>Indexed:</b> ${customId}`;
    await bot.editMessageCaption(newCaption, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: 'HTML'
    }).catch(() => {});

  } catch (err) {
    console.error('Index Error:', err);
  }
});

// ============================================================
// --- COMMANDS ---
// ============================================================

// 1. /start
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
  const chatId     = msg.chat.id;
  const fromId     = String(msg.from.id);
  const startParam = match[1];

  await saveUser(msg);

  // Ban check
  if (await isUserBanned(fromId)) {
    return bot.sendMessage(chatId, '🚫 <b>You have been banned from using this bot.</b>', { parse_mode: 'HTML' });
  }

  // Group: show private-chat button
  if (msg.chat.type !== 'private') {
    if (startParam) return;
    const sent = await bot.sendMessage(chatId, `👋 <b>Hello! I work in Private Chat.</b>\nClick below to start:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🤖 Start Me', url: `https://t.me/${BOT_USERNAME}` }]] }
    });
    return autoDeleteMessage(bot, chatId, sent.message_id, 10000);
  }

  // Deep link (e.g. /start F0001)
  if (startParam && /^F\d{4}$/i.test(startParam)) {
    if (!await verifyJoin(chatId, fromId, startParam)) return;

    const customId = startParam.toUpperCase();
    const file = await File.findOne({ customId }).lean();
    if (!file) return bot.sendMessage(chatId, '❌ File not found.');

    if ((await getUserLimitCount(fromId)) >= DAILY_LIMIT_NUM) {
      return bot.sendMessage(chatId, '⚠️ Daily limit reached. Try again tomorrow.');
    }

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

  // Standard welcome
  if (!await verifyJoin(chatId, fromId)) return;
  bot.sendMessage(chatId,
    `👋 <b>Welcome, ${msg.from.first_name}!</b>\n\n` +
    `🔎 <b>How to search:</b>\nSimply type the name of the movie.\n<i>Example: "Avengers" or "Breaking Bad"</i>\n\n` +
    `📂 Use /help for more details`,
    { parse_mode: 'HTML' }
  );
});

// 2. /help
bot.onText(/\/help/, async (msg) => {
  if (msg.chat.type !== 'private') return;

  const isAdmin = ADMIN_SET.has(String(msg.from.id));
  let text =
    `📚 <b>Help Guide</b>\n\n` +
    `🔎 <b>Search:</b> Just type the movie/show name.\n` +
    `   Supports <b>fuzzy search</b> – partial names work too!\n` +
    `❤️ <b>/favorites</b> – Save files for later (max ${FAV_LIMIT_NUM}).\n` +
    `📊 <b>/trending</b> – See what's popular.\n` +
    `🆕 <b>/recent</b> – Latest uploads.\n` +
    `👤 <b>/myaccount</b> – Your daily limit (${DAILY_LIMIT_NUM}/day).`;

  if (isAdmin) {
    text +=
      `\n\n👮‍♂️ <b>Admin Commands:</b>\n` +
      `/stats – Bot statistics\n` +
      `/broadcast – Message all users\n` +
      `/delete [ID] – Remove a file\n` +
      `/ban [userId] – Ban a user\n` +
      `/unban [userId] – Unban a user`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

// 3. /trending
bot.onText(/\/trending/, async (msg) => {
  const chatId   = msg.chat.id;
  const isGroup  = msg.chat.type !== 'private';

  if (isGroup && !await checkGroupCooldown(chatId)) return;

  const files = await File.find().sort({ downloads: -1 }).limit(TRENDING_LIMIT_NUM).lean();
  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No trending files yet.');
    return autoDeleteMessage(bot, chatId, sent.message_id, 5000);
  }

  if (isGroup) {
    const keyboard = files.map(f => [{
      text: `📥 ${f.file_size} | ${f.clean_title}`,
      url: `https://t.me/${BOT_USERNAME}?start=${f.customId}`
    }]);
    const sent = await bot.sendMessage(chatId, '📈 <b>Top Trending:</b>', {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    }).catch(() => null);
    if (sent) autoDeleteMessage(bot, chatId, sent.message_id, GROUP_DELETE_TIME);
  } else {
    const keyboard = files.map(f => [{
      text: `🔥 ${f.file_size} | ${f.clean_title}`,
      callback_data: `GET:${f.customId}`
    }]);
    const sent = await bot.sendMessage(chatId, '📈 <b>Top Trending:</b>', {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    }).catch(() => null);
    if (sent) autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
  }
});

// 4. /recent
bot.onText(/\/recent/, async (msg) => {
  const chatId  = msg.chat.id;
  const isGroup = msg.chat.type !== 'private';

  if (isGroup && !await checkGroupCooldown(chatId)) return;

  const files = await File.find().sort({ uploaded_at: -1 }).limit(RECENT_LIMIT_NUM).lean();
  if (!files.length) {
    const sent = await bot.sendMessage(chatId, 'No recent files.');
    return autoDeleteMessage(bot, chatId, sent.message_id, 5000);
  }

  if (isGroup) {
    const keyboard = files.map(f => [{
      text: `🆕 ${f.file_size} | ${f.clean_title}`,
      url: `https://t.me/${BOT_USERNAME}?start=${f.customId}`
    }]);
    const sent = await bot.sendMessage(chatId, '🆕 <b>Recent Uploads:</b>', {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    }).catch(() => null);
    if (sent) autoDeleteMessage(bot, chatId, sent.message_id, GROUP_DELETE_TIME);
  } else {
    const keyboard = files.map(f => [{
      text: `📂 ${f.file_size} | ${f.clean_title}`,
      callback_data: `GET:${f.customId}`
    }]);
    const sent = await bot.sendMessage(chatId, '🆕 <b>Recent Uploads:</b>', {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
    }).catch(() => null);
    if (sent) autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
  }
});

// 5. /favorites & /myaccount
bot.onText(/\/favorites|\/myaccount/, async (msg) => {
  if (msg.chat.type !== 'private') {
    const sent = await bot.sendMessage(msg.chat.id, `⚠️ <b>This command is for Private Chat only!</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🤖 Open Private Chat', url: `https://t.me/${BOT_USERNAME}` }]] }
    });
    return autoDeleteMessage(bot, msg.chat.id, sent.message_id, 10000);
  }

  if (msg.text.includes('myaccount')) {
    const used = await getUserLimitCount(String(msg.from.id));
    const sent = await bot.sendMessage(msg.chat.id,
      `👤 <b>Account</b>\nUsed Today: <b>${used}/${DAILY_LIMIT_NUM}</b>\n✅ Limit resets daily at midnight UTC`,
      { parse_mode: 'HTML' }
    );
    return autoDeleteMessage(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
  }

  // /favorites
  const favs = await Favorite.find({ userId: String(msg.from.id) }).lean();
  if (!favs.length) {
    const sent = await bot.sendMessage(msg.chat.id, '❤️ No favorites saved yet. Press the ❤️ button on any file to save it!');
    return autoDeleteMessage(bot, msg.chat.id, sent.message_id, 8000);
  }

  const files = await File.find({ customId: { $in: favs.map(f => f.customId) } }).lean();
  const keyboard = files.map(f => [{ text: `⭐ ${f.file_size} | ${f.clean_title}`, callback_data: `GET:${f.customId}` }]);
  const sent = await bot.sendMessage(msg.chat.id, `❤️ <b>Your Favorites (${files.length}/${FAV_LIMIT_NUM}):</b>`, {
    parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, msg.chat.id, sent.message_id, PRIVATE_DELETE_TIME);
});

// 6. /stats (Admin Only)
bot.onText(/\/stats/, async (msg) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const [userCount, fileCount, bannedCount] = await Promise.all([
    User.countDocuments(),
    File.countDocuments(),
    User.countDocuments({ isBanned: true })
  ]);

  bot.sendMessage(msg.chat.id,
    `📊 <b>Bot Statistics</b>\n\n` +
    `👥 Total Users: <b>${userCount}</b>\n` +
    `🚫 Banned Users: <b>${bannedCount}</b>\n` +
    `📂 Total Files: <b>${fileCount}</b>`,
    { parse_mode: 'HTML' }
  );
});

// 7. /broadcast (Admin Only)
bot.onText(/\/broadcast(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = String(msg.from.id);
  if (!ADMIN_SET.has(fromId)) return;

  const text     = match[1];
  const replyMsg = msg.reply_to_message;

  if (!text && !replyMsg) {
    return bot.sendMessage(chatId,
      '⚠️ <b>Usage:</b>\n1. <code>/broadcast Your message</code>\n2. Reply to any message with <code>/broadcast</code>',
      { parse_mode: 'HTML' }
    );
  }

  const users = await User.find({ isBanned: false }, { userId: 1 }).lean();
  let success = 0, blocked = 0;

  const sentMsg = await bot.sendMessage(chatId, `🚀 Broadcasting to ${users.length} users...`);

  for (const user of users) {
    try {
      if (replyMsg) {
        await bot.copyMessage(user.userId, chatId, replyMsg.message_id);
      } else {
        await bot.sendMessage(user.userId, text, { parse_mode: 'HTML' });
      }
      success++;
    } catch (err) {
      if (err.response && err.response.statusCode === 403) blocked++;
    }
    await new Promise(r => setTimeout(r, 50));
  }

  bot.editMessageText(
    `✅ <b>Broadcast Complete</b>\n\nSent: ${success}\nBlocked/Failed: ${blocked}`,
    { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: 'HTML' }
  );
});

// 8. /delete (Admin Only)
bot.onText(/\/delete (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const customId = match[1].trim().toUpperCase();
  const result   = await File.deleteOne({ customId });

  if (result.deletedCount > 0) {
    bot.sendMessage(msg.chat.id,
      `🗑️ <b>Deleted:</b> File <code>${customId}</code> has been removed.`,
      { parse_mode: 'HTML' }
    );
  } else {
    bot.sendMessage(msg.chat.id,
      `❌ <b>Not found:</b> <code>${customId}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

// 9. /ban (Admin Only)
bot.onText(/\/ban (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const targetId = match[1].trim();
  const result   = await User.findOneAndUpdate(
    { userId: targetId },
    { isBanned: true },
    { new: true }
  );

  if (result) {
    bot.sendMessage(msg.chat.id,
      `🚫 <b>User <code>${targetId}</code> has been banned.</b>`,
      { parse_mode: 'HTML' }
    );
  } else {
    bot.sendMessage(msg.chat.id,
      `❌ User <code>${targetId}</code> not found in database.`,
      { parse_mode: 'HTML' }
    );
  }
});

// 10. /unban (Admin Only)
bot.onText(/\/unban (.+)/, async (msg, match) => {
  if (!ADMIN_SET.has(String(msg.from.id))) return;

  const targetId = match[1].trim();
  const result   = await User.findOneAndUpdate(
    { userId: targetId },
    { isBanned: false },
    { new: true }
  );

  if (result) {
    bot.sendMessage(msg.chat.id,
      `✅ <b>User <code>${targetId}</code> has been unbanned.</b>`,
      { parse_mode: 'HTML' }
    );
  } else {
    bot.sendMessage(msg.chat.id,
      `❌ User <code>${targetId}</code> not found in database.`,
      { parse_mode: 'HTML' }
    );
  }
});

// ============================================================
// --- MAIN MESSAGE LOGIC ---
// ============================================================
bot.on('message', async (msg) => {

  // Bot added to group – show welcome
  if (msg.new_chat_members) {
    const isMe = msg.new_chat_members.find(m => m.username === BOT_USERNAME);
    if (isMe) {
      return bot.sendMessage(msg.chat.id,
        `👋 <b>Thanks for adding me!</b>\n\n` +
        `ℹ️ <b>How to use:</b>\n` +
        `1. Make me an <b>Admin</b>.\n` +
        `2. Users can type movie names to search.\n` +
        `3. I will send a download link button (Files delivered via Private DM).\n\n` +
        `🚀 <i>Enjoy!</i>`,
        { parse_mode: 'HTML' }
      );
    }
  }

  if (!msg.text || msg.text.startsWith('/') || msg.from?.is_bot || msg.chat.type === 'channel') return;

  const chatId  = msg.chat.id;
  const fromId  = String(msg.from.id);
  const isGroup = msg.chat.type !== 'private';
  const text    = msg.text.trim();

  // Ban check
  if (await isUserBanned(fromId)) return;

  // ---- GROUP SEARCH ----
  if (isGroup) {
    if (!await checkGroupCooldown(chatId)) return;

    const { files, isFuzzy } = await searchFiles(text, GROUP_SEARCH_LIMIT_NUM);

    if (files.length > 0) {
      const header = isFuzzy
        ? `🔍 <b>Fuzzy results for "${text}":</b>`
        : `🔍 <b>Found ${files.length} result(s):</b>`;
      const keyboard = files.map(f => [{
        text: `📥 ${f.file_size} | ${f.clean_title}`,
        url: `https://t.me/${BOT_USERNAME}?start=${f.customId}`
      }]);
      const sent = await bot.sendMessage(chatId, header, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
      }).catch(() => null);
      if (sent) autoDeleteMessage(bot, chatId, sent.message_id, GROUP_DELETE_TIME);

    } else {
      // Suggestions
      const suggestions = await getSearchSuggestions(text);
      let noResultText = `🤷‍♂️ <b>Could not find "${text}"</b>\nTry checking the spelling.`;

      if (suggestions.length) {
        noResultText += `\n\n💡 <b>Did you mean:</b>\n` +
          suggestions.map(s => `• ${s.clean_title}`).join('\n');
      }

      const sent = await bot.sendMessage(chatId, noResultText, { parse_mode: 'HTML' }).catch(() => null);
      if (sent) autoDeleteMessage(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
    }
    return;
  }

  // ---- PRIVATE SEARCH ----
  await saveUser(msg);
  if (!await verifyJoin(chatId, fromId)) return;

  const { files: allMatches, isFuzzy } = await searchFiles(text, 100);

  if (!allMatches.length) {
    const suggestions = await getSearchSuggestions(text);
    let noResultText = `🔍 <b>No results for "${text}".</b>`;

    if (suggestions.length) {
      noResultText += `\n\n💡 <b>Did you mean one of these?</b>`;
      const suggKeyboard = suggestions.map(s => [{
        text: `🔎 ${s.clean_title}`,
        callback_data: `SEARCH_SUGGEST:${s.clean_title}`
      }]);
      const sent = await bot.sendMessage(chatId, noResultText, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: suggKeyboard }
      });
      return autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
    }

    const sent = await bot.sendMessage(chatId, noResultText, { parse_mode: 'HTML' });
    return autoDeleteMessage(bot, chatId, sent.message_id, NO_RESULT_DELETE_TIME);
  }

  const fileIds = allMatches.map(f => f.customId);
  await cacheSearchResults(fromId, fileIds);

  const { ids, total } = await getCachedPage(fromId, 0);
  const files = await File.find({ customId: { $in: ids } }).sort({ uploaded_at: -1 }).lean();

  const header = isFuzzy
    ? `🔍 Found <b>${total}</b> fuzzy match(es) for "<i>${text}</i>":` 
    : `🔍 Found <b>${total}</b> file(s):`;

  // Landscape-aware: show more detail in button label
  // Telegram doesn't expose orientation, but we send a rich label so landscape sees it better
  const keyboard = files.map(f => [{
    text: `📂 ${f.type === 'video' ? '🎬' : '📄'} ${f.clean_title} • ${f.file_size}`,
    callback_data: `GET:${f.customId}`
  }]);

  if (total > RESULTS_PER_PAGE_NUM) {
    keyboard.push([{
      text: `Page 1 of ${Math.ceil(total / RESULTS_PER_PAGE_NUM)} ➡️`,
      callback_data: `PAGE:1`
    }]);
  }

  const sent = await bot.sendMessage(chatId, header, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => null);
  if (sent) autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
});

// ============================================================
// --- CALLBACKS ---
// ============================================================
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const fromId = String(q.from.id);
  const data   = q.data;

  // Ban check
  if (await isUserBanned(fromId)) {
    return bot.answerCallbackQuery(q.id, { text: '🚫 You are banned.', show_alert: true });
  }

  // --- CHECK JOIN ---
  if (data.startsWith('CHECK_JOIN')) {
    const parts    = data.split(':');
    const fileCode = parts[1] || null;

    await clearMemberCache(fromId);

    if (await verifyJoin(chatId, fromId, fileCode)) {
      bot.sendMessage(chatId, '✅ Thanks! You can now search for files.');
      bot.deleteMessage(chatId, q.message.message_id).catch(() => {});
    } else {
      bot.answerCallbackQuery(q.id, { text: '❌ You have not joined yet!', show_alert: true });
    }
    return;
  }

  if (!await verifyJoin(chatId, fromId)) {
    return bot.answerCallbackQuery(q.id, { text: 'Please join the channel first!' });
  }

  try {
    // --- SEARCH SUGGESTION CLICK ---
    if (data.startsWith('SEARCH_SUGGEST:')) {
      const suggTitle = data.slice('SEARCH_SUGGEST:'.length);
      await bot.answerCallbackQuery(q.id, { text: `Searching: ${suggTitle}` });

      const { files: suggestedFiles } = await searchFiles(suggTitle, 100);
      if (!suggestedFiles.length) {
        return bot.sendMessage(chatId, `❌ No files found for "${suggTitle}".`);
      }

      const fileIds = suggestedFiles.map(f => f.customId);
      await cacheSearchResults(fromId, fileIds);
      const { ids, total } = await getCachedPage(fromId, 0);
      const files = await File.find({ customId: { $in: ids } }).sort({ uploaded_at: -1 }).lean();

      const keyboard = files.map(f => [{
        text: `📂 ${f.type === 'video' ? '🎬' : '📄'} ${f.clean_title} • ${f.file_size}`,
        callback_data: `GET:${f.customId}`
      }]);
      if (total > RESULTS_PER_PAGE_NUM) {
        keyboard.push([{ text: `Page 1 of ${Math.ceil(total / RESULTS_PER_PAGE_NUM)} ➡️`, callback_data: `PAGE:1` }]);
      }

      const sent = await bot.sendMessage(chatId, `🔍 Found <b>${total}</b> file(s) for "<i>${suggTitle}</i>":`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
      });
      autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
      return;
    }

    // --- PAGINATION ---
    if (data.startsWith('PAGE:')) {
      const page = Number(data.split(':')[1]);
      const { ids, total } = await getCachedPage(fromId, page);

      if (!ids.length) return bot.answerCallbackQuery(q.id, { text: 'Search expired. Please search again.' });

      const files = await File.find({ customId: { $in: ids } }).sort({ uploaded_at: -1 }).lean();
      const keyboard = files.map(f => [{
        text: `📂 ${f.type === 'video' ? '🎬' : '📄'} ${f.clean_title} • ${f.file_size}`,
        callback_data: `GET:${f.customId}`
      }]);

      const nav = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `PAGE:${page - 1}` });
      if ((page + 1) * RESULTS_PER_PAGE_NUM < total) nav.push({ text: 'Next ➡️', callback_data: `PAGE:${page + 1}` });
      if (nav.length) keyboard.push(nav);

      await bot.editMessageText(
        `🔍 Results — Page <b>${page + 1}</b> of <b>${Math.ceil(total / RESULTS_PER_PAGE_NUM)}</b>`,
        {
          chat_id: chatId,
          message_id: q.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        }
      );
      return;
    }

    // --- GET FILE ---
    if (data.startsWith('GET:')) {
      const customId = data.split(':')[1];
      const file     = await File.findOne({ customId }).lean();
      if (!file) return bot.answerCallbackQuery(q.id, { text: '❌ File no longer exists.', show_alert: true });

      if ((await getUserLimitCount(fromId)) >= DAILY_LIMIT_NUM) {
        return bot.answerCallbackQuery(q.id, {
          text: `⚠️ Daily limit of ${DAILY_LIMIT_NUM} reached. Resets at midnight UTC.`,
          show_alert: true
        });
      }

      await bot.answerCallbackQuery(q.id, { text: '📤 Sending file...' });
      await incrementAndGetLimit(fromId);
      await File.updateOne({ _id: file._id }, { $inc: { downloads: 1 } });

      const sent = await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, file.message_id, {
        caption:
          `🎬 <b>${file.clean_title}</b>\n` +
          `📦 Size: ${file.file_size}\n` +
          `🎞 Type: ${file.type || 'file'}\n` +
          `🆔 ID: <code>${file.customId}</code>\n\n` +
          `⚠️ <i>Auto-deletes in ${PRIVATE_DELETE_TIME / 1000}s</i>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❤️ Add to Favorites', callback_data: `FAV:${file.customId}` }]]
        }
      });
      autoDeleteMessage(bot, chatId, sent.message_id, PRIVATE_DELETE_TIME);
      return;
    }

    // --- FAVORITE ---
    if (data.startsWith('FAV:')) {
      const customId = data.split(':')[1];
      const exists   = await Favorite.findOne({ userId: fromId, customId });

      if (exists) {
        await Favorite.deleteOne({ userId: fromId, customId });
        bot.answerCallbackQuery(q.id, { text: '💔 Removed from favorites.' });
      } else {
        const count = await Favorite.countDocuments({ userId: fromId });
        if (count >= FAV_LIMIT_NUM) {
          return bot.answerCallbackQuery(q.id, {
            text: `❌ Max ${FAV_LIMIT_NUM} favorites allowed. Remove one first.`,
            show_alert: true
          });
        }
        await Favorite.create({ userId: fromId, customId });
        bot.answerCallbackQuery(q.id, { text: '❤️ Saved to favorites!' });
      }
      return;
    }

  } catch (e) {
    console.error('Callback Error:', e);
    bot.answerCallbackQuery(q.id, { text: '⚠️ Something went wrong. Please try again.' });
  }
});

// ============================================================
// --- GRACEFUL SHUTDOWN ---
// ============================================================
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await mongoose.disconnect();
  process.exit(0);
});