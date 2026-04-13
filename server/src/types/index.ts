// User with embedded Anthropic account (one account per user)
export interface User {
  id: string;
  username: string;
  api_key_hash: string;
  api_key_prefix: string;

  // Anthropic OAuth credentials (null if not linked)
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;

  // Usage stats
  usage_5h: number;
  usage_7d: number;
  reset_5h: string | null;
  reset_7d: string | null;
  usage_updated_at: string | null;

  // Sharing settings
  is_active: boolean;
  share_limit_percent: number;

  // Rate limit tracking
  is_rate_limited: boolean;
  rate_limited_until: string | null;

  created_at: string;
  last_seen_at: string | null;
}

// User info returned to clients (no sensitive data)
export interface UserInfo {
  id: string;
  username: string;
  created_at: string;
  has_account: boolean;
  account: AccountInfo | null;
}

export interface AccountInfo {
  is_active: boolean;
  share_limit_percent: number;
  usage: UsageStats | null;
  is_rate_limited: boolean;
  rate_limited_until: string | null;
}

export interface UsageStats {
  usage_5h: number;
  usage_7d: number;
  reset_5h: string | null;
  reset_7d: string | null;
  updated_at: string | null;
}

// Pool member view (what other users see)
export interface PoolMember {
  id: string;
  username: string;
  is_active: boolean;
  share_limit_percent: number;
  usage: UsageStats | null;
  is_rate_limited: boolean;
  is_me: boolean;
  is_next: boolean;
  load_score: number | null;
}

export interface PoolStatus {
  total_members: number;
  active_accounts: number;
  rate_limited_accounts: number;
  available_accounts: number;
  pool_usage_5h: number;
  pool_usage_7d: number;
}

// OAuth related
export interface OAuthSession {
  state: string;
  code_verifier: string;
  created_at: number;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// API responses
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface RegisterResponse {
  id: string;
  username: string;
  api_key: string;
  has_account: boolean;
}

// Express request with authenticated user
export interface AuthenticatedRequest {
  user: User;
}

// Config
export interface ServerConfig {
  port: number;
  nodeEnv: string;
  databasePath: string;
  encryptionKey: string;
  apiKeySaltRounds: number;
  adminApiKey: string;
  anthropicClientId: string;
  anthropicRedirectUri: string;
  logLevel: string;
  enableRequestLogging: boolean;
  claudeHomeRoot: string;
  claudeBin: string;
  claudeMaxConcurrent: number;
  claudeTimeoutMs: number;
  claudeSessionTtlMs: number;
}
