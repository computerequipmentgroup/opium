//! Core types for Opium

use serde::{Deserialize, Serialize};

/// Server connection configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServerConfig {
    /// Server URL (e.g., "http://localhost:8082" or "https://opium.example.com")
    pub url: Option<String>,
    /// API key for authentication
    pub api_key: Option<String>,
    /// Whether server mode is enabled
    pub enabled: bool,
}

impl ServerConfig {
    pub fn is_configured(&self) -> bool {
        self.enabled && self.url.is_some() && self.api_key.is_some()
    }
}

/// Pool member from server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolMember {
    pub id: String,
    pub email: String,
    pub is_active: bool,
    pub share_limit_percent: i32,
    pub usage: Option<ServerUsageStats>,
    pub is_rate_limited: bool,
    pub is_me: bool,
    #[serde(default)]
    pub is_next: bool,
    pub load_score: Option<f64>,
}

/// Usage stats from server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerUsageStats {
    pub usage_5h: f64,
    pub usage_7d: f64,
    pub reset_5h: Option<String>,
    pub reset_7d: Option<String>,
    pub updated_at: Option<String>,
}

/// Pool summary from server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolSummary {
    pub total_members: i32,
    pub active_accounts: i32,
    pub rate_limited: i32,
    pub available: i32,
}

/// Server pool response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolResponse {
    pub members: Vec<PoolMember>,
    pub summary: PoolSummary,
}

/// Server user info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerUserInfo {
    pub id: String,
    pub email: String,
    pub created_at: String,
    pub has_account: bool,
    pub account: Option<ServerAccountInfo>,
}

/// Server account info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerAccountInfo {
    pub is_active: bool,
    pub share_limit_percent: i32,
    pub usage: Option<ServerUsageStats>,
    pub is_rate_limited: bool,
    pub rate_limited_until: Option<String>,
}

/// Generic API response wrapper
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

/// OAuth start response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthStartResponse {
    pub auth_url: String,
    pub state: String,
}

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Proxy port (default: 8082)
    pub proxy_port: u16,
    /// Server connection configuration
    #[serde(default)]
    pub server: ServerConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            proxy_port: 8082,
            server: ServerConfig::default(),
        }
    }
}

/// Persistent application state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppData {
    pub config: Config,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            config: Config::default(),
        }
    }
}

/// Status of the proxy server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyStatus {
    pub running: bool,
    pub port: u16,
    pub requests_proxied: u64,
}
