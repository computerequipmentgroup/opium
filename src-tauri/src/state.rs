//! Application state management

use crate::types::{AppData, Config, ProxyStatus};
use anyhow::{Context, Result};
use directories::ProjectDirs;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// Shared application state
pub struct AppState {
    /// Persistent data (config)
    data: RwLock<AppData>,
    /// Path to data file
    data_path: PathBuf,
    /// Whether the proxy is running
    proxy_running: AtomicBool,
    /// Proxy port
    proxy_port: RwLock<u16>,
    /// Number of requests proxied
    requests_proxied: AtomicU64,
}

impl AppState {
    /// Create new app state, loading from disk if available
    pub fn new() -> Result<Self> {
        let data_path = Self::get_data_path()?;
        let data = Self::load_data(&data_path)?;
        let port = data.config.proxy_port;

        Ok(Self {
            data: RwLock::new(data),
            data_path,
            proxy_running: AtomicBool::new(false),
            proxy_port: RwLock::new(port),
            requests_proxied: AtomicU64::new(0),
        })
    }

    /// Get the data directory path
    fn get_data_path() -> Result<PathBuf> {
        let proj_dirs = ProjectDirs::from("com", "opium", "proxy")
            .context("Could not determine data directory")?;

        let data_dir = proj_dirs.data_dir();
        std::fs::create_dir_all(data_dir)?;

        Ok(data_dir.join("state.json"))
    }

    /// Load data from disk
    fn load_data(path: &PathBuf) -> Result<AppData> {
        if path.exists() {
            let contents = std::fs::read_to_string(path)?;
            let data: AppData = serde_json::from_str(&contents)?;
            Ok(data)
        } else {
            Ok(AppData::default())
        }
    }

    /// Save data to disk
    pub fn save(&self) -> Result<()> {
        let data = self.data.read();
        let contents = serde_json::to_string_pretty(&*data)?;
        std::fs::write(&self.data_path, contents)?;
        Ok(())
    }

    /// Get current config
    pub fn get_config(&self) -> Config {
        self.data.read().config.clone()
    }

    /// Update config
    pub fn update_config(&self, config: Config) -> Result<()> {
        let mut data = self.data.write();
        *self.proxy_port.write() = config.proxy_port;
        data.config = config;
        drop(data);
        self.save()
    }

    /// Get proxy status
    pub fn get_proxy_status(&self) -> ProxyStatus {
        ProxyStatus {
            running: self.proxy_running.load(Ordering::Relaxed),
            port: *self.proxy_port.read(),
            requests_proxied: self.requests_proxied.load(Ordering::Relaxed),
        }
    }

    /// Set proxy running state
    pub fn set_proxy_running(&self, running: bool) {
        self.proxy_running.store(running, Ordering::Relaxed);
    }

    /// Increment request counter
    pub fn increment_requests(&self) {
        self.requests_proxied.fetch_add(1, Ordering::Relaxed);
    }

    /// Get proxy port
    pub fn get_proxy_port(&self) -> u16 {
        *self.proxy_port.read()
    }
}

/// Thread-safe wrapper for AppState
pub type SharedState = Arc<AppState>;

/// Create a new shared state
pub fn create_shared_state() -> Result<SharedState> {
    Ok(Arc::new(AppState::new()?))
}
