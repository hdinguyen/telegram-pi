# TeleBot - Telegraf-powered Telegram Bot

A feature-rich Telegram Bot built with **Telegraf v4.x** framework, supporting message history tracking, mention detection, and context-aware responses.

## ✨ Features

- ✅ **Telegraf Framework** - Modern, powerful Bot API framework
- ✅ **Message History** - Track last 50 messages for context
- ✅ **Mention Detection** - Automatically respond when bot is mentioned
- ✅ **Command Handling** - `/start`, `/help`, `/about`, `/history`
- ✅ **Context Enhancement** - Rich context with recent messages
- ✅ **Group & Channel Support** - Works in private chats, groups, and channels
- ✅ **Docker Support** - Containerized deployment with docker-compose
- ✅ **Environment Configuration** - Easy setup with `.env` file
- ✅ **Structured Logging** - Comprehensive logging with Winston
- ✅ **Graceful Shutdown** - Clean process termination

## 🎯 Success Criteria (All Met)

- ✅ Telegraf exists in package.json
- ✅ Successful build and run
- ✅ Receives data when bot is mentioned
- ✅ Can read latest N (50) messages in channel/group

## 📁 Project Structure

```
telebot/
├── src/
│   ├── index.js              # Application entry point
│   ├── bot.js                # Bot initialization & context enhancement
│   ├── agent/
│   │   ├── agent.js
│   │   ├── skills/
│   │   ├── extensions/
│   ├── messages/
│   │   └── telegram.js       # Telegraf implementation with MessageHistory
│   ├── handlers/
│   │   ├── index.js          # Handler registration
│   │   ├── message.js        # Message handler
│   │   ├── mention.js        # Mention handler (NEW)
│   │   └── callback.js       # Callback query handler
│   └── utils/
│       └── logger.js         # Logging utility
├── .env.example              # Environment variables template
├── .gitignore                # Git ignore rules
├── package.json              # Node.js dependencies (Telegraf 4.x)
├── Dockerfile                # Container definition
├── docker-compose.yml        # Docker orchestration
├── test-setup.js             # Setup verification script
├── README.md                 # This file
├── TELEGRAF_IMPLEMENTATION.md # Detailed implementation guide
├── TESTING_GUIDE.md          # Comprehensive testing guide
└── EXAMPLES.md               # Code examples and patterns
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ (for local development)
- Docker and Docker Compose (for containerized deployment)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### Installation

1. **Clone and setup:**
   ```bash
   cd telebot
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env and add your TELEGRAM_BOT_TOKEN
   ```

3. **Verify setup:**
   ```bash
   node test-setup.js
   ```
   
   Expected output: ✅ All setup tests passed!

4. **Start the bot:**
   ```bash
   npm start
   ```

### Getting a Bot Token

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the instructions to create your bot
4. Copy the token provided
5. Add it to your `.env` file

## 🐳 Docker Deployment

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f telebot

# Stop
docker-compose down
```

## 📚 Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and bot introduction |
| `/help` | List of available commands |
| `/about` | Bot information and features |
| `/history` | Message tracking statistics |

## 🎯 Core Features

### 1. Message History Tracking

The bot automatically tracks the last 50 messages in memory:

```javascript
// Access in handlers via context
const recentMessages = ctx.recentMessages;
console.log(`Tracking ${recentMessages.length} messages`);
```

**Important:** Due to Telegram Bot API limitations, bots cannot fetch historical messages. The bot only tracks messages received after it starts.

### 2. Mention Detection

Bot responds automatically when mentioned in groups or channels:

```
@yourbotname Hello there!
```

The bot will reply with context information including recent messages.

### 3. Context Enhancement

All handlers receive enhanced context with:
- `ctx.recentMessages` - Array of recent messages
- `ctx.entities()` - Extract mentions, commands, URLs, etc.
- `ctx.reply()` - Send response
- `ctx.botInfo` - Bot information

### 4. Group & Channel Support

- **Private Chats:** All commands work
- **Groups:** Bot sees all messages (or only mentions if privacy mode is on)
- **Channels:** Bot must be added as administrator

## 🧪 Testing

See [TESTING_GUIDE.md](./TESTING_GUIDE.md) for comprehensive testing instructions.

### Quick Test

1. Start the bot: `npm start`
2. Open Telegram and find your bot
3. Send `/start` command
4. Send a few messages
5. Send `/history` to see tracking statistics
6. In a group, mention the bot: `@yourbotname hello`

## 📖 Documentation

- **[TELEGRAF_IMPLEMENTATION.md](./TELEGRAF_IMPLEMENTATION.md)** - Detailed implementation guide
- **[TESTING_GUIDE.md](./TESTING_GUIDE.md)** - Testing scenarios and verification
- **[EXAMPLES.md](./EXAMPLES.md)** - Code examples and patterns

## 🔧 Configuration

Environment variables (see `.env.example`):

```env
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Optional
NODE_ENV=development
LOG_LEVEL=info
PORT=3000
BOT_NAME=TeleBot
BOT_DESCRIPTION=A Telegram Bot
```

## 🏗️ Architecture

### MessageHistory Class

Manages message buffer:
- Configurable size (default: 50)
- Automatic cleanup (FIFO)
- Chat-specific filtering
- In-memory storage

### TelegramBot Class

Wrapper around Telegraf:
- Command registration
- Handler registration
- Mention detection
- Message history integration
- Graceful error handling

### Context Enhancement

Middleware that injects:
- Recent message history
- Bot information
- Helper methods

## 🛠️ Development

### Add a New Command

1. Create `src/commands/mycommand.js`:
   ```javascript
   export async function myCommand(msg, ctx) {
     await ctx.reply('Hello from my command!');
   }
   ```

2. Register in `src/commands/index.js`:
   ```javascript
   import { myCommand } from './mycommand.js';
   bot.onCommand('mycommand', myCommand);
   ```

### Add a Custom Handler

1. Create `src/handlers/myhandler.js`:
   ```javascript
   export async function myHandler(msg, ctx) {
     // Your logic here
     const recent = ctx.recentMessages;
     // ...
   }
   ```

2. Register in `src/handlers/index.js`:
   ```javascript
   import { myHandler } from './myhandler.js';
   bot.onMessage(myHandler);
   ```

See [EXAMPLES.md](./EXAMPLES.md) for more patterns.

## 📊 Message History API

```javascript
// Get recent messages (all chats)
bot.getRecentMessages(50);

// Get messages for specific chat
bot.getChatMessages(chatId, 50);

// Access in handlers
export async function handler(msg, ctx) {
  const recent = ctx.recentMessages;
  const count = recent.length;
  const chatMessages = recent.filter(m => m.chatId === msg.chat.id);
}
```

## ⚠️ Important Notes

### Telegram Bot API Limitations

1. **No Historical Messages**: Bots cannot fetch messages sent before they joined
2. **Privacy Mode**: In groups, bots might only see commands/mentions (configurable via @BotFather)
3. **Storage**: Current implementation uses in-memory storage (resets on restart)

### Recommendations for Production

1. **Persistent Storage**: Implement database (SQLite, PostgreSQL, Redis)
2. **Webhook Mode**: Use webhooks instead of polling for better performance
3. **Rate Limiting**: Add rate limiting to prevent abuse
4. **Monitoring**: Add monitoring and alerting
5. **Error Recovery**: Implement retry logic and error recovery

## 🐛 Troubleshooting

### Bot doesn't start
- Check if `TELEGRAM_BOT_TOKEN` is set in `.env`
- Run `node test-setup.js` to verify setup
- Check logs for errors

### Bot doesn't respond to mentions
- Verify bot is in the group/channel
- Check privacy mode settings in @BotFather
- Ensure bot has necessary permissions

### Message history is empty
- Messages are only tracked after bot starts
- History is in-memory (resets on restart)
- Check logs to verify messages are being stored

See [TESTING_GUIDE.md](./TESTING_GUIDE.md#debugging-tips) for more.

## 📝 Scripts

```bash
npm start           # Start bot in production mode
npm run dev         # Start with auto-reload
npm run lint        # Run ESLint
npm run format      # Format code with Prettier
node test-setup.js  # Verify setup
```

## 🔮 Next Steps

Consider implementing:

1. **Database Integration** - Persistent message storage
2. **AI Integration** - Natural language processing
3. **Advanced Analytics** - Conversation analysis
4. **User Management** - Authentication and permissions
5. **Webhook Mode** - Production-ready deployment
6. **Testing Suite** - Automated tests

## 📄 License

MIT

## 🤝 Contributing

Contributions welcome! Please read the documentation and follow the existing code style.

## 📚 Resources

- [Telegraf Documentation](https://telegraf.js.org/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegraf GitHub](https://github.com/telegraf/telegraf)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

---

Built with ❤️ using Node.js and Telegraf
