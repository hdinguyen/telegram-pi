# Pi Agent Integration

This directory contains the Pi Agent integration for the Telegram bot, built on top of `@earendil-works/pi-coding-agent`.

## Architecture

The agent system consists of three main components:

### 1. `config.js` - Agent Configuration
- Sets up the resource loader with custom prompts
- Configures skill discovery from `.pi/skills/`
- Adds Telegram-specific instructions to the system prompt

### 2. `agent.js` - Core Agent Logic
- `PiAgent` class manages the agent session
- Handles message processing with context awareness
- Streams responses from the agent
- Tracks tool usage for debugging

### 3. `index.js` - Export Module
- Provides singleton `piAgent` instance
- Exports helper functions and classes

## Usage

### Initialize the Agent

The agent is lazy-initialized on first use in the mention handler:

```javascript
import { piAgent } from './agent/index.js';
import { getAgentOptions } from './agent/config.js';

// Initialize once
if (!piAgent.isInitialized) {
  await piAgent.initialize(getAgentOptions());
}
```

### Process Messages

```javascript
const response = await piAgent.processMessage(query, {
  recentMessages: ctx.recentMessages,  // Array of recent messages
  chatType: ctx.chat.type,              // 'private', 'group', 'supergroup'
  username: ctx.from.username,          // User identifier
  chatTitle: ctx.chat.title             // Chat name
});

// Send response back to user
await ctx.reply(response.text);

// Log tools used (optional)
if (response.tools.length > 0) {
  console.log('Tools used:', response.tools);
}
```

## Context Enhancement

The agent automatically enhances prompts with:

1. **Chat Context**: Type and title of the conversation
2. **User Info**: Username/identifier of the sender
3. **Message History**: Last 10 messages for context awareness
4. **Query**: The actual user query

Example enhanced prompt:
```
[Chat: Tech Support Group (group)]
[From: johndoe]

<conversation_history>
alice: Hey, can someone help with React?
johndoe: @mybot what's the difference between useEffect and useLayoutEffect?
</conversation_history>

User query: what's the difference between useEffect and useLayoutEffect?
```

## Skills

Skills are automatically discovered from:
- `.pi/skills/` (project-specific)
- `~/.pi/agent/skills/` (global)
- Installed npm packages via `.pi/settings.json`

Current skills loaded:
- `telegram-bot` - Telegram-specific guidance
- Any skills from `pi-web-access` package (if configured)

## Custom Prompts

The agent includes Telegram-specific instructions:

- Keep responses under 4096 characters
- Use Markdown formatting
- Be concise and mobile-friendly
- Consider chat history
- Structure responses with bullet points

## Session Management

Currently uses **in-memory sessions** - conversation history is ephemeral and resets on bot restart.

For persistent sessions, modify `agent.js`:

```javascript
// In initialize()
const result = await createAgentSession({
  resourceLoader: this.loader,
  sessionManager: SessionManager.filesystem('./.sessions')  // Persist to disk
});
```

## Error Handling

The agent includes comprehensive error handling:

1. **Initialization errors**: Caught in mention handler with user-friendly message
2. **Processing errors**: Logged and returned as error message to user
3. **Tool errors**: Logged but don't interrupt response generation

## Debugging

Enable debug logging in `.env`:

```bash
LOG_LEVEL=debug
```

This shows:
- Skills loaded on startup
- Context passed to agent
- Response length and tool usage
- Any diagnostics or warnings

## Extension Points

### Add Custom Skills

1. Create a new skill directory: `.pi/skills/my-skill/`
2. Add `SKILL.md` with instructions
3. Skills are auto-loaded on agent initialization

### Modify System Prompt

Edit `config.js` → `appendSystemPromptOverride()`:

```javascript
appendSystemPromptOverride: (base) => [
  ...base,
  `## My Custom Instructions
  - Always include emojis
  - End responses with a fun fact`
]
```

### Filter Skills

Edit `config.js` → `skillsOverride()`:

```javascript
skillsOverride: (current) => {
  // Only load skills matching pattern
  const filtered = current.skills.filter(s => 
    s.name.includes('telegram') || s.name.includes('web')
  );
  return { ...current, skills: filtered };
}
```

## References

- Pi Coding Agent SDK: [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- Example: Custom Prompts: [03-custom-prompt.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts)
- Example: Skills: [04-skills.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/04-skills.ts)
