require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const REQUIRED_CHANNELS_FILE = path.join(__dirname, 'channels.json');
const MOVIES_FILE = path.join(__dirname, 'movies.json');

const ADMIN_IDS = [5126669135];
let movieData = fs.existsSync(MOVIES_FILE) ? JSON.parse(fs.readFileSync(MOVIES_FILE)) : { storage_channel_id: null, movies: {} };
let REQUIRED_CHANNELS = JSON.parse(fs.readFileSync(REQUIRED_CHANNELS_FILE));
const MOVIES = movieData.movies;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const pendingAdd = {}; // temp memory for /add command or panel action
const pendingBroadcast = {};
const pendingDelete = {};
const pendingChannels = {};
let USERS = new Set();

function saveMoviesJSON() {
  fs.writeFileSync(MOVIES_FILE, JSON.stringify(movieData, null, 2));
}

function saveChannelsJSON() {
  fs.writeFileSync(REQUIRED_CHANNELS_FILE, JSON.stringify(REQUIRED_CHANNELS, null, 2));
}

async function getNotJoinedChannels(userId) {
  const notJoined = [];

  for (const channel of REQUIRED_CHANNELS) {
    try {
      const res = await bot.getChatMember(channel, userId);
      if (['left', 'kicked'].includes(res.status)) {
        notJoined.push(channel);
      }
    } catch {
      notJoined.push(channel);
    }
  }

  return notJoined;
}

function createFollowButtons(channels) {
  return channels.map(channel => {
    return [{ text: `🔗 Join ${channel}`, url: `https://t.me/${channel.replace('@', '')}` }];
  }).concat([[{ text: "✅ I’ve joined", callback_data: 'recheck' }]]);
}

const adminPanel = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "📥 Add Movie", callback_data: "add_movie" }],
      [{ text: "🗑️ Delete Movie", callback_data: "delete_movie" }],
      [{ text: "📊 View Stats", callback_data: "view_stats" }],
      [{ text: "🔗 Update Channels", callback_data: "update_channels" }],
      [{ text: "📢 Broadcast", callback_data: "broadcast" }],
      [{ text: "📩 Export Data", callback_data: "export_data" }]
    ]
  }
};

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const name = msg.from.first_name || "there";
  USERS.add(userId);

  const notJoined = await getNotJoinedChannels(userId);

  if (notJoined.length > 0) {
    return bot.sendMessage(chatId, `👋 Welcome, ${name}!\n\nTo use this bot, please follow these channels:`, {
      reply_markup: { inline_keyboard: createFollowButtons(notJoined) }
    });
  }

  bot.sendMessage(chatId, `✅ You're all set, ${name}! Just send me a movie code (like \`1\`, \`2\`, etc.) to get your movie.`, {
    parse_mode: 'Markdown'
  });
});

bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!ADMIN_IDS.includes(userId)) return;
  bot.sendMessage(chatId, `👑 Admin Panel`, adminPanel);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (data === 'recheck') {
    const notJoined = await getNotJoinedChannels(userId);
    if (notJoined.length > 0) {
      return bot.sendMessage(chatId, `🚫 You still need to follow these channels:`, {
        reply_markup: { inline_keyboard: createFollowButtons(notJoined) }
      });
    }
    return bot.sendMessage(chatId, `🎉 You're verified now! Send me a movie code to get your file.`);
  }

  if (!ADMIN_IDS.includes(userId)) return;

  if (data === "add_movie") {
    const codes = Object.keys(MOVIES).map(Number);
    const nextCode = (codes.length ? Math.max(...codes) : 0) + 1;
    pendingAdd[userId] = nextCode.toString();
    bot.sendMessage(chatId, `📄 Send me the movie for code *${nextCode}*`, { parse_mode: 'Markdown' });
  }

  if (data === "delete_movie") {
    pendingDelete[userId] = true;
    bot.sendMessage(chatId, `🗑️ Send the movie code you want to delete.`);
  }

  if (data === "view_stats") {
    const totalUsers = USERS.size;
    const totalMovies = Object.keys(MOVIES).length;
    bot.sendMessage(chatId, `📊 Stats:\n👥 Users: ${totalUsers}\n🎬 Movies: ${totalMovies}`);
  }

  if (data === "update_channels") {
    pendingChannels[userId] = true;
    bot.sendMessage(chatId, `🔗 Send new required channels list (e.g. @ch1 @ch2)`);
  }

  if (data === "broadcast") {
    pendingBroadcast[userId] = true;
    bot.sendMessage(chatId, `📢 Send the message you want to broadcast to all users.`);
  }

  if (data === "export_data") {
    bot.sendDocument(chatId, MOVIES_FILE);
  }

  bot.answerCallbackQuery(query.id);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim();

  USERS.add(userId);

  if (pendingAdd[userId]) {
    if (msg.forward_from_chat && msg.forward_from_message_id) {
      const code = pendingAdd[userId];
      movieData.storage_channel_id = msg.forward_from_chat.id;
      MOVIES[code] = msg.forward_from_message_id;
      saveMoviesJSON();
      bot.sendMessage(chatId, `✅ Saved movie code *${code}*`, { parse_mode: 'Markdown' });
      delete pendingAdd[userId];
    } else {
      bot.sendMessage(chatId, `⚠️ Please forward a message from a *channel*`, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (pendingDelete[userId]) {
    const code = text;
    if (MOVIES[code]) {
      delete MOVIES[code];
      saveMoviesJSON();
      bot.sendMessage(chatId, `🗑️ Deleted movie code ${code}`);
    } else {
      bot.sendMessage(chatId, `❌ Code not found.`);
    }
    delete pendingDelete[userId];
    return;
  }

  if (pendingBroadcast[userId]) {
    for (let uid of USERS) {
        try {
        if (msg.photo) {
            const photo = msg.photo[msg.photo.length - 1].file_id;
            await bot.sendPhoto(uid, photo, { caption: msg.caption || '' });
        } else if (msg.video) {
            await bot.sendVideo(uid, msg.video.file_id, { caption: msg.caption || '' });
        } else if (msg.document) {
            await bot.sendDocument(uid, msg.document.file_id, { caption: msg.caption || '' });
        } else if (msg.audio) {
            await bot.sendAudio(uid, msg.audio.file_id, { caption: msg.caption || '' });
        } else if (msg.voice) {
            await bot.sendVoice(uid, msg.voice.file_id);
        } else if (msg.text) {
            await bot.sendMessage(uid, msg.text);
        }
        } catch (e) {
        console.log(`Failed to send to ${uid}: ${e.message}`);
        }
    }
    bot.sendMessage(chatId, `✅ Message broadcasted to all users.`);
    delete pendingBroadcast[userId];
    return;
  }


  if (pendingChannels[userId]) {
    REQUIRED_CHANNELS = text.split(/\s+/);
    saveChannelsJSON();
    bot.sendMessage(chatId, `🔁 Updated required channels list.`);
    delete pendingChannels[userId];
    return;
  }

  // normal movie request
  if (!text || text.startsWith('/')) return;
  const notJoined = await getNotJoinedChannels(userId);
  if (notJoined.length > 0) {
    return bot.sendMessage(chatId, `⚠️ Please follow all required channels:`, {
      reply_markup: { inline_keyboard: createFollowButtons(notJoined) }
    });
  }

  const messageId = MOVIES[text];
  if (!messageId) {
    return bot.sendMessage(chatId, `❌ Movie code *${text}* not found.`, { parse_mode: 'Markdown' });
  }

  try {
    await bot.copyMessage(chatId, movieData.storage_channel_id, messageId);
  } catch (err) {
    console.error('❗ Error forwarding movie:', err.message);
    bot.sendMessage(chatId, `⚠️ Couldn't fetch the movie right now. Try again later.`);
  }
});
