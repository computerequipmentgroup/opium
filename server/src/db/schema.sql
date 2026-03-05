-- Users table (each user has exactly one Anthropic account)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                    -- UUID
    username TEXT UNIQUE NOT NULL,          -- Username (display name in pool)
    api_key_hash TEXT NOT NULL,             -- Hashed API key
    api_key_prefix TEXT NOT NULL,           -- First 8 chars for identification (e.g., "op_abc123")
    
    -- Anthropic OAuth credentials (encrypted at rest)
    -- NULL if user hasn't linked their account yet
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TEXT,
    
    -- Usage stats (synced from Anthropic headers)
    usage_5h REAL DEFAULT 0,                -- 0.0 to 1.0
    usage_7d REAL DEFAULT 0,
    reset_5h TEXT,
    reset_7d TEXT,
    usage_updated_at TEXT,
    
    -- Sharing settings (only owner can modify these)
    is_active INTEGER DEFAULT 0,            -- Active in the pool (0 until account linked)
    share_limit_percent INTEGER DEFAULT 100,-- 0-100, how much others can use
    
    -- Rate limit tracking
    is_rate_limited INTEGER DEFAULT 0,
    rate_limited_until TEXT,
    
    -- Stats
    requests_total INTEGER DEFAULT 0,       -- Total requests made through this account
    requests_by_owner INTEGER DEFAULT 0,    -- Requests by the owner
    requests_by_others INTEGER DEFAULT 0,   -- Requests by other users
    
    created_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT
);

-- Usage log for tracking who used what (aggregated, not per-request)
CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- Whose account was used
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,      -- Who made the request
    date TEXT NOT NULL,                     -- Aggregated by day (YYYY-MM-DD)
    request_count INTEGER DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,          -- If tracked
    
    UNIQUE(account_owner_id, requester_id, date)
);

-- OAuth sessions (temporary, for PKCE flow)
CREATE TABLE IF NOT EXISTS oauth_sessions (
    state TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Server configuration
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active, is_rate_limited);
CREATE INDEX IF NOT EXISTS idx_users_api_key_prefix ON users(api_key_prefix);
CREATE INDEX IF NOT EXISTS idx_usage_owner_date ON usage_logs(account_owner_id, date);
CREATE INDEX IF NOT EXISTS idx_usage_requester_date ON usage_logs(requester_id, date);
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_user ON oauth_sessions(user_id);
