//! Tauri commands for frontend interaction

use crate::server_client::ServerClient;
use crate::state::SharedState;
use crate::types::{Config, PoolResponse, ProxyStatus, ServerConfig};

use tauri::State;

/// Result type for commands
type CmdResult<T> = Result<T, String>;

/// Get proxy status
#[tauri::command]
pub fn get_proxy_status(state: State<'_, SharedState>) -> CmdResult<ProxyStatus> {
    Ok(state.get_proxy_status())
}

/// Get config
#[tauri::command]
pub fn get_config(state: State<'_, SharedState>) -> CmdResult<Config> {
    Ok(state.get_config())
}

/// Update config
#[tauri::command]
pub fn update_config(state: State<'_, SharedState>, config: Config) -> CmdResult<()> {
    state.update_config(config).map_err(|e| e.to_string())
}

// ==================== Server Mode Commands ====================

/// Test server connection
#[tauri::command]
pub async fn test_server_connection(url: String, api_key: String) -> CmdResult<String> {
    let config = ServerConfig {
        url: Some(url),
        api_key: Some(api_key),
        enabled: true,
    };

    let client = ServerClient::new(&config).map_err(|e| e.to_string())?;
    client
        .test_connection()
        .await
        .map_err(|e| e.to_string())?;

    // Get user info to verify API key
    let user_info = client.get_user_info().await.map_err(|e| e.to_string())?;
    Ok(user_info.email)
}

/// Get pool members from server
#[tauri::command]
pub async fn get_pool(state: State<'_, SharedState>) -> CmdResult<PoolResponse> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client.get_pool().await.map_err(|e| e.to_string())
}

/// Start OAuth flow in server mode
#[tauri::command]
pub async fn server_start_oauth(state: State<'_, SharedState>) -> CmdResult<String> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    let response = client.start_oauth().await.map_err(|e| e.to_string())?;

    // Open the auth URL in browser
    if let Err(e) = open::that(&response.auth_url) {
        tracing::warn!("Failed to open browser: {}", e);
    }

    Ok(response.state)
}

/// Complete OAuth flow in server mode
#[tauri::command(rename_all = "camelCase")]
pub async fn server_complete_oauth(
    state: State<'_, SharedState>,
    code: String,
    oauth_state: String,
) -> CmdResult<()> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client
        .complete_oauth(&code, &oauth_state)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update account active status in server mode
#[tauri::command(rename_all = "camelCase")]
pub async fn server_set_active(
    state: State<'_, SharedState>,
    is_active: bool,
) -> CmdResult<()> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client
        .update_account(Some(is_active), None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Update account share limit in server mode
#[tauri::command(rename_all = "camelCase")]
pub async fn server_set_share_limit(
    state: State<'_, SharedState>,
    share_limit_percent: i32,
) -> CmdResult<()> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client
        .update_account(None, Some(share_limit_percent))
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Sync account in server mode
#[tauri::command]
pub async fn server_sync_account(state: State<'_, SharedState>) -> CmdResult<()> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client.sync_account().await.map_err(|e| e.to_string())?;

    Ok(())
}

/// Sync all pool members' usage in server mode
#[tauri::command]
pub async fn server_sync_pool(state: State<'_, SharedState>) -> CmdResult<PoolResponse> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client.sync_pool().await.map_err(|e| e.to_string())
}

/// Unlink Anthropic account in server mode
#[tauri::command]
pub async fn server_unlink_account(state: State<'_, SharedState>) -> CmdResult<()> {
    let config = state.get_config();
    if !config.server.is_configured() {
        return Err("Server not configured".to_string());
    }

    let client = ServerClient::new(&config.server).map_err(|e| e.to_string())?;
    client.unlink_account().await.map_err(|e| e.to_string())?;

    Ok(())
}

/// Check if server mode is enabled
#[tauri::command]
pub fn is_server_mode(state: State<'_, SharedState>) -> bool {
    state.get_config().server.is_configured()
}
