# 📂 Telegram File Store Bot

A professional, high-performance Telegram bot for indexing, searching, and delivering files securely. It supports **Force Join**, **Group Search Previews**, **Admin Broadcasts**, and **MongoDB/Redis** caching for speed.

## 🚀 Features

* **Private File Storage:** Files are stored in a private channel; users never see the source.
* **Smart Search:** Fast keyword search with Redis caching and pagination.
* **Group Support:** Works in groups with "Preview Mode" (redirects users to DM for delivery).
* **Force Join:** Forces users to join a specific channel before accessing files.
* **Deep Linking:** Auto-delivers files after a user joins the channel.
* **Admin Controls:** Broadcast messages, view stats, and delete files.
* **Anti-Spam:** Rate limits, auto-delete timers, and cooldowns for groups.

---

## 🛠️ Installation

### 1. Prerequisites
* Node.js (v16 or higher)
* MongoDB Database (Atlas or Local)
* Redis Database (for caching)

### 2. Setup
1.  **Clone the project:**
    ```bash
    git clone [https://github.com/Aman-20/TelegramFileDeliverBot.git](https://github.com/Aman-20/TelegramFileDeliverBot.git)
    cd telegram-file-bot
    ```

2.  **Install dependencies:**
    ```bash
    npm install node-telegram-bot-api mongoose ioredis dotenv express
    ```

3.  **Configure Environment:**
    Create a `.env` file in the root directory and fill in the details (see below).

4.  **Run the bot:**
    ```bash
    node bot.js
    ```

---

## ⚙️ Configuration (.env)

| Variable | Description |
| :--- | :--- |
| `TELEGRAM_TOKEN` | Your Bot Token from @BotFather |
| `MONGODB_URI` | Your MongoDB Connection String |
| `REDIS_URL` | Your Redis Connection String (e.g., redis://user:pass@host:port) |
| `ADMIN_IDS` | Comma-separated Admin IDs (e.g., `12345,67890`) |
| `STORAGE_CHANNEL_ID` | ID of the Private Channel where you upload files (e.g., `-100...`) |
| `FORCE_CHANNEL_ID` | ID of the Channel users MUST join (e.g., `-100...` or `@channel`) |
| `DAILY_LIMIT` | Max downloads per user per day (Default: 100) |
| `FAV_LIMIT` | Max favorites per user (Default: 50) |
| `RENDER_EXTERNAL_URL` | (Optional) URL for Webhook if using Render/Heroku |

---

## 📖 Usage Guide

### 📤 How to Upload Files
1.  Add the bot as an **Admin** to your **Storage Channel**.
2.  Simply **upload** or **forward** a file (Video/Document) to that channel.
3.  The bot will automatically index it and edit the caption with an ID (e.g., `Indexed: F0001`).

### 🔎 How Users Search
* **Private Chat:** Type any movie name. The bot returns a paginated list.
* **Group Chat:** Type a movie name. The bot shows a "Preview" button. Clicking it takes the user to the bot to download the file securely.

### 👮‍♂️ Admin Commands
* `/broadcast [message]` - Send a message to all bot users.
* `/broadcast` (Reply to message) - Forward the replied message to all users.
* `/stats` - (Custom implementation required if needed).

### 👤 For Users
* **Search:** Just type the name of the movie (e.g., "Iron Man").
* **Commands:**
    * `/start` - Welcome menu
    * `/recent` - See newly uploaded files
    * `/trending` - See most popular files
    * `/favorites` - View saved files
    * `/myaccount` - Check daily download limit

---

## ☁️ Deployment (Render.com)

This bot is optimized for **Render** using Webhooks.

1.  Create a new **Web Service** on Render.
2.  Connect your GitHub repository.
3.  Add the **Environment Variables** listed above in the Render dashboard.
4.  **Important:** Ensure `RENDER_EXTERNAL_URL` matches your Render app's URL (e.g., `https://your-bot-name.onrender.com`).
5.  Deploy! 🚀

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to fork this repository and submit a pull request.

## 📝 License

This project is licensed under the MIT License.