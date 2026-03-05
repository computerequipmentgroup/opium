# Opium Proxy Server

A Node.js server that manages your Anthropic Claude accounts. Automatically switches between your accounts when one hits its rate limit.

## Disclaimer

> This software does not condone account sharing or ToS violations. It is intended solely as a tool to help manage your own accounts. The developers are not responsible for how you choose to use this software. Not affiliated with Anthropic.

## Features

- **Load Balancing**: Automatically select the best available account
- **Usage Limits**: Set percentage-based limits on each account
- **Rate Limit Handling**: Automatic switching when an account hits rate limits

## Quick Start

### Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

### Production (Docker)

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f
```

## API Endpoints

### Authentication

All endpoints (except register) require an API key in the `Authorization` header:

```
Authorization: Bearer op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/users/register` | Create API key |
| GET | `/api/v1/users/me` | Get current user info |
| POST | `/api/v1/users/me/regenerate-key` | Generate new API key |

### Account Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/account/oauth/start` | Start OAuth flow |
| POST | `/api/v1/account/oauth/complete` | Complete OAuth with code |
| PATCH | `/api/v1/account` | Update account settings |
| DELETE | `/api/v1/account` | Remove (unlink) account |
| POST | `/api/v1/account/sync` | Sync usage stats |

### Pool

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/pool` | List all accounts |
| GET | `/api/v1/pool/status` | Get pool status summary |

### Statistics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/stats/me` | Get your usage statistics |

### Proxy

| Method | Endpoint | Description |
|--------|----------|-------------|
| * | `/v1/*` | Proxy to Anthropic API |

## Usage Flow

1. **Create API Key**: Generate an API key to authenticate with the proxy
   ```bash
   curl -X POST http://localhost:8082/api/v1/users/register \
     -H "Content-Type: application/json" \
     -d '{"email": "you@example.com"}'
   ```

2. **Link Account**: Start OAuth to link your Anthropic account
   ```bash
   curl -X POST http://localhost:8082/api/v1/account/oauth/start \
     -H "Authorization: Bearer op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```
   
   Open the returned `auth_url` in your browser, authorize, and copy the code.

3. **Complete OAuth**: Submit the authorization code
   ```bash
   curl -X POST http://localhost:8082/api/v1/account/oauth/complete \
     -H "Authorization: Bearer op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
     -H "Content-Type: application/json" \
     -d '{"code": "CODE_FROM_ANTHROPIC", "state": "STATE_FROM_START"}'
   ```

4. **Configure Limit**: Set a usage limit (optional)
   ```bash
   curl -X PATCH http://localhost:8082/api/v1/account \
     -H "Authorization: Bearer op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
     -H "Content-Type: application/json" \
     -d '{"share_limit_percent": 50}'
   ```

5. **Use the Proxy**: Make requests to Claude through the proxy
   ```bash
   curl -X POST http://localhost:8082/v1/messages \
     -H "Authorization: Bearer op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "claude-sonnet-4-20250514",
       "max_tokens": 1024,
       "messages": [{"role": "user", "content": "Hello!"}]
     }'
   ```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8082 | Server port |
| `NODE_ENV` | development | Environment |
| `DATABASE_PATH` | ./data/opium.db | SQLite database path |
| `ENCRYPTION_KEY` | (required) | 32-char key for token encryption |
| `API_KEY_SALT_ROUNDS` | 12 | bcrypt salt rounds |
| `LOG_LEVEL` | info | Logging level |
| `ENABLE_REQUEST_LOGGING` | false | Log all requests |

## Load Balancing Algorithm

The server selects accounts based on:

1. **Availability**: Must be active and not rate-limited
2. **Usage Limits**: Must not exceed configured limit
3. **Load Score**: Prioritizes accounts with lower usage

Load score formula: `usage_5h * 2 + usage_7d`

## Security

- API keys are hashed with bcrypt
- OAuth tokens are encrypted with AES-256-GCM
- All endpoints require authentication (except register)

## Development

```bash
# Type check
npm run typecheck

# Run tests
npm test

# Build for production
npm run build
```
