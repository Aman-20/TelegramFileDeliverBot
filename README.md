# 🎬 Telegram File Search Bot

A production-ready Telegram bot that indexes files from a private storage channel and lets users search and download them — with fuzzy search, daily limits, favorites, group support, and admin tools. Built with Node.js, MongoDB, and deployed on Render.

---

## ✨ Features

### For Users
- 🔎 **Smart Search** — Exact keyword match with automatic fuzzy fallback
- 💡 **Search Suggestions** — Shows similar titles when nothing is found
- 📄 **Paginated Results** — Browse results page by page
- ❤️ **Favorites** — Save up to 50 files for quick access
- 📈 **Trending** — See the most downloaded files
- 🆕 **Recent** — Browse the latest uploads
- 👤 **My Account** — Check daily download usage
- ⏱️ **Auto-Delete** — Messages auto-delete to keep chats clean
- 🔗 **Deep Links** — Share direct file links (works in groups too)

### For Groups
- Group members can search directly in the chat
- Results send a private DM link — files are never posted publicly
- Per-group cooldown to prevent spam

### For Admins
- 📊 `/stats` — Total users, files, and banned count
- 📢 `/broadcast` — Send a message or forward any content to all users
- 🗑️ `/delete [ID]` — Remove a file from the index
- 🚫 `/ban [userId]` — Ban a user
- ✅ `/unban [userId]` — Unban a user

### Indexing
- Files posted to the storage channel are **automatically indexed**
- Caption is updated with the assigned file ID after indexing
- Supports `video` and `document` type files

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM, `type: "module"`) |
| Telegram | `node-telegram-bot-api` (webhook mode) |
| Database | MongoDB via Mongoose |
| Server | Express.js |
| Hosting | Render (Web Service) |

---

## 📁 Project Structure

```
.
├── bot.js          # Main bot file (single-file architecture)
├── .env            # Environment variables
├── package.json
└── README.md
```

---

## ⚙️ Environment Variables

Create a `.env` file in the root directory. All variables marked **required** must be set or the bot will refuse to start.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | — | Bot token from [@BotFather](https://t.me/BotFather) |
| `MONGODB_URI` | ✅ | — | MongoDB connection string |
| `STORAGE_CHANNEL_ID` | ✅ | — | Channel ID where files are stored (e.g. `-100xxxxxxxxxx`) |
| `RENDER_EXTERNAL_URL` | ✅ | — | Your Render app URL (e.g. `https://your-app.onrender.com`) |
| `ADMIN_IDS` | ⚠️ | `''` | Comma-separated Telegram user IDs with admin access |
| `FORCE_CHANNEL_ID` | ⚠️ | — | Channel ID or `@username` users must join before using the bot |
| `DAILY_LIMIT` | ➖ | `100` | Max downloads per user per day |
| `RESULTS_PER_PAGE` | ➖ | `10` | Search results shown per page |
| `FAV_LIMIT` | ➖ | `50` | Max favorites per user |
| `PRIVATE_AUTO_DELETE_MS` | ➖ | `60000` | How long (ms) private messages stay before auto-delete |
| `GROUP_AUTO_DELETE_MS` | ➖ | `60000` | How long (ms) group messages stay before auto-delete |
| `GROUP_COOLDOWN_MS` | ➖ | `2000` | Cooldown (ms) between searches in the same group |
| `NO_RESULT_DELETE_MS` | ➖ | `60000` | How long (ms) "no results" messages stay |
| `TRENDING_LIMIT` | ➖ | `10` | Number of files shown in `/trending` |
| `RECENT_LIMIT` | ➖ | `10` | Number of files shown in `/recent` |
| `FUZZY_MIN_WORD_LEN` | ➖ | `3` | Minimum word length for fuzzy search fallback |
| `SUGGESTION_LIMIT` | ➖ | `5` | Max suggestions shown when no results found |
| `LIMIT_DOC_TTL_DAYS` | ➖ | `2` | Days to keep daily-limit records in MongoDB |
| `MEMBER_DOC_TTL_DAYS` | ➖ | `7` | Days to cache channel membership checks |
| `SEARCH_CACHE_DOC_TTL_DAYS` | ➖ | `0.001` | Days to keep search result cache (~1.5 min) |

### `.env.example`

```env
# Required
TELEGRAM_TOKEN=your_bot_token_here
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/
STORAGE_CHANNEL_ID=-100xxxxxxxxxx
RENDER_EXTERNAL_URL=https://your-app.onrender.com

# Recommended
ADMIN_IDS=123456789,987654321
FORCE_CHANNEL_ID=@your_channel

# Optional (defaults shown)
DAILY_LIMIT=100
RESULTS_PER_PAGE=10
FAV_LIMIT=50
PRIVATE_AUTO_DELETE_MS=60000
GROUP_AUTO_DELETE_MS=60000
GROUP_COOLDOWN_MS=2000
NO_RESULT_DELETE_MS=60000
TRENDING_LIMIT=10
RECENT_LIMIT=10
FUZZY_MIN_WORD_LEN=3
SUGGESTION_LIMIT=5
LIMIT_DOC_TTL_DAYS=2
MEMBER_DOC_TTL_DAYS=7
SEARCH_CACHE_DOC_TTL_DAYS=0.001
```

---

## 🚀 Deployment on Render

### 1. Prerequisites
- A [Render](https://render.com) account
- A MongoDB database (e.g. [MongoDB Atlas](https://www.mongodb.com/atlas) free tier)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A **private** Telegram channel for file storage where the bot is an admin

### 2. Setup the Storage Channel
1. Create a private Telegram channel
2. Add your bot as an **Administrator** with permission to post messages and edit messages
3. Get the channel ID by forwarding a message from it to [@userinfobot](https://t.me/userinfobot)

### 3. Deploy to Render
1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → **New Web Service**
3. Connect your GitHub repo
4. Configure the service:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node bot.js`
5. Add all environment variables from the table above under **Environment**
6. Set `RENDER_EXTERNAL_URL` to your Render app's URL (visible after first deploy)
7. Click **Deploy**

### 4. Verify
After deploy, check the Render logs for:
```
✅ MongoDB Connected
✅ Bot @your_bot_username ready
✅ Server on port 3000
```

---

## 🏃 Running Locally

```bash
# 1. Clone the repo
git clone https://github.com/Aman-20/TelegramFileDeliverBot.git
cd your-repo

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env with your values

# 4. Run the bot
node bot.js
```

> **Note:** Local mode requires a public webhook URL. Use a tunneling tool like [ngrok](https://ngrok.com) and set `RENDER_EXTERNAL_URL` to your ngrok URL.

---

## 📋 User Commands

| Command | Description |
|---|---|
| `/start` | Welcome message / re-authenticate |
| `/help` | Full command guide |
| `/trending` | Most downloaded files |
| `/recent` | Latest uploaded files |
| `/favorites` | Your saved files |
| `/myaccount` | Check your daily download usage |

## 🔐 Admin Commands

| Command | Description |
|---|---|
| `/stats` | Bot statistics (users, files, banned) |
| `/broadcast <message>` | Send a message to all users |
| `/broadcast` *(reply to msg)* | Forward any message to all users |
| `/delete <FILE_ID>` | Remove a file from the index |
| `/ban <userId>` | Ban a user from the bot |
| `/unban <userId>` | Unban a user |

---

## 🗄️ Database Collections

| Collection | TTL | Purpose |
|---|---|---|
| `users` | Never | User profiles and ban status |
| `files` | Never | Indexed file metadata |
| `counters` | Never | Auto-increment sequence for file IDs |
| `limits` | `LIMIT_DOC_TTL_DAYS` | Daily download counts per user |
| `membercaches` | `MEMBER_DOC_TTL_DAYS` | Channel membership verification cache |
| `searchcaches` | `SEARCH_CACHE_DOC_TTL_DAYS` | Paginated search result sessions |
| `groupcooldowns` | 1 day | Per-group search cooldown tracking |
| `favorites` | Never | User-saved file references |

---

## 🔍 How Search Works

1. **Exact match** — Splits query into keywords and looks for files whose `attributes` array contains all of them (`$all`). Fast and precise.
2. **Fuzzy fallback** — If nothing is found, runs a partial `$regex` match on each word ≥ `FUZZY_MIN_WORD_LEN` characters. Catches typos and partial titles.
3. **Suggestions** — If both fail, scores the top 200 most-downloaded files by word overlap with the query and shows the best matches.

---

## 📦 `package.json`

Make sure your `package.json` includes `"type": "module"` since the bot uses ES module syntax (`import`/`export`):

```json
{
  "name": "telegram-file-bot",
  "version": "1.0.0",
  "type": "module",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js"
  },
  "dependencies": {
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "mongoose": "^8.0.0",
    "node-telegram-bot-api": "^0.64.0"
  }
}
```

---

## ⚠️ Important Notes

- The bot must be an **admin** in the storage channel to index files and generate invite links.
- If `FORCE_CHANNEL_ID` is set, the bot must also be an admin in that channel to verify membership.
- Daily limits reset at **midnight UTC**.
- File IDs are sequential in format `F0001`, `F0002`, etc.

---

## 📄 License

MIT — feel free to use, modify, and distribute.
