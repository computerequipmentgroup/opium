<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Opium" width="128" height="128">
</p>

<h1 align="center">Opium</h1>

<p align="center">
  <strong>Load balancer for your Claude Pro/Max subscription accounts.</strong>
  <br>
  <sub>Manage multiple personal accounts to maximize your included usage allowance.</sub>
  <br>
  <sub>Works with <a href="https://opencode.ai">OpenCode</a> and other tools that support custom API endpoints.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.0-24C8D8?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2.0">
  <img src="https://img.shields.io/badge/Rust-DEA584?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
</p>

---

## Disclaimer

> This software does not condone account sharing or ToS violations. It is intended solely as a tool to help manage your own accounts. The developers are not responsible for how you choose to use this software. Not affiliated with Anthropic.

---

## What is this?

Claude Pro ($20/mo) and Max ($100/mo) subscriptions each include their own independent usage allowance. Opium automates switching between your accounts when one hits its limit — the same thing you'd do manually by logging out and back in.

No account's limit is bypassed or extended; each still caps out exactly as Anthropic intends.

> **Note:** This is for Claude Pro/Max subscription accounts only, not for API token credits.

## Features

- OAuth authentication with automatic token refresh
- Rate limit detection with automatic account switching
- Usage tracking (5-hour and 24-hour windows)
- Smart load balancing with reset-aware scheduling
- Drain accounts before their usage window resets

## How Account Selection Works

When a request comes in, Opium selects the best available account using a **load score** algorithm:

### Base Score Calculation

```
loadScore = (usage_5h × 2) + usage_7d
```

The 5-hour usage is weighted 2× more than the 7-day usage, prioritizing accounts with lower recent activity.

### Drain Mode (Forced Selection)

**If an account resets in ≤ 30 minutes and is below 95% usage, it gets forced selection** (score = -1000). This ensures no capacity is wasted—accounts get fully drained before their reset window.

### Reset Time Bonus

For accounts not in drain mode, a bonus is applied:

| Time until 5h reset | Score multiplier | Effect |
|---------------------|------------------|--------|
| ≤ 30 min (≥95% used) | × 1.0 | Already drained |
| ≤ 60 minutes | × 0.2 | Strongly preferred |
| ≤ 120 minutes | × 0.5 | Moderately preferred |
| > 120 minutes | × 1.0 | No bonus |

### Example

| Account | 5h Usage | Resets in | Selection |
|---------|----------|-----------|-----------|
| A | 60% | 15 min | **FORCED** (drain mode) |
| B | 20% | 3 hours | Normal scoring |
| C | 95% | 10 min | Normal (already drained) |

Account A will be used exclusively until it hits 95% or resets, ensuring no capacity is lost.

### Usage Limits

Each account can have a **usage limit** (0-100%) controlling how much of its allowance can be consumed before switching to another account. This helps preserve capacity across your accounts.

**Exception:** If an account resets in ≤ 10 minutes and is below 95% usage, limits are bypassed to allow full draining before the reset window.

## Usage

1. Start Opium Balance and add one or more Anthropic accounts
2. Proxy runs on `http://127.0.0.1:8082`
3. Configure your AI tools to use the proxy URL

## Server Setup

### Create an API Key

Create a local API key to authenticate your tools with the proxy. Registration requires the master API key (set via `MASTER_API_KEY` environment variable).

> **Note:** Despite the endpoint name, this does not create a "user" in a multi-user sense. It generates a local API key for you to authenticate your development tools with your own Opium instance.

```bash
curl -X POST http://localhost:8082/api/v1/users/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <MASTER_API_KEY>" \
  -d '{"username": "alice"}'
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "username": "alice",
    "api_key": "op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "has_account": false
  }
}
```

Save the `api_key` - you'll need it to authenticate your tools with the proxy.

### Link Your Anthropic Account

After creating an API key, use the Opium desktop app to link your own Anthropic account via OAuth.

## OpenCode Setup

To use the balancer with OpenCode, place an `opencode.json` in **each folder** where you want to use it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "op_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "baseURL": "http://127.0.0.1:8082/v1"
      }
    }
  }
}
```

Replace the API key with your Opium API key (obtained when creating an API key above).

OpenCode reads this config from the current working directory and routes all Anthropic API requests through the proxy.

**Global alternative:** Place the config at `~/.config/opencode/opencode.json` to apply it everywhere.

## Build

### Prerequisites

- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/)
- [Tauri CLI](https://tauri.app/): `npm install`

### Development

```bash
npm run tauri dev
```

### Production Build

```bash
npm run tauri build
```

The bundled app will be in `src-tauri/target/release/bundle/`.
