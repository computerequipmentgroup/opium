//! Client for communicating with the Opium Server

use crate::types::{
    ApiResponse, OAuthStartResponse, PoolResponse, ServerAccountInfo, ServerConfig, ServerUserInfo,
};
use anyhow::{anyhow, Context, Result};
use reqwest::Client;

/// Client for the Opium Server API
pub struct ServerClient {
    client: Client,
    base_url: String,
    api_key: String,
}

impl ServerClient {
    /// Create a new server client
    pub fn new(config: &ServerConfig) -> Result<Self> {
        let base_url = config
            .url
            .as_ref()
            .ok_or_else(|| anyhow!("Server URL not configured"))?
            .trim_end_matches('/')
            .to_string();

        let api_key = config
            .api_key
            .as_ref()
            .ok_or_else(|| anyhow!("API key not configured"))?
            .clone();

        Ok(Self {
            client: Client::new(),
            base_url,
            api_key,
        })
    }

    /// Make an authenticated GET request
    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await
            .context("Failed to send request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Request failed: {} - {}", status, body));
        }

        let api_response: ApiResponse<T> = response.json().await.context("Failed to parse response")?;

        if !api_response.success {
            return Err(anyhow!(
                "API error: {}",
                api_response.error.unwrap_or_else(|| "Unknown error".to_string())
            ));
        }

        api_response
            .data
            .ok_or_else(|| anyhow!("No data in response"))
    }

    /// Make an authenticated POST request
    async fn post<T: serde::de::DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: Option<&B>,
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let mut request = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json");

        if let Some(b) = body {
            request = request.json(b);
        }

        let response = request.send().await.context("Failed to send request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Request failed: {} - {}", status, body));
        }

        let api_response: ApiResponse<T> = response.json().await.context("Failed to parse response")?;

        if !api_response.success {
            return Err(anyhow!(
                "API error: {}",
                api_response.error.unwrap_or_else(|| "Unknown error".to_string())
            ));
        }

        api_response
            .data
            .ok_or_else(|| anyhow!("No data in response"))
    }

    /// Make an authenticated PATCH request
    async fn patch<T: serde::de::DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .context("Failed to send request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Request failed: {} - {}", status, body));
        }

        let api_response: ApiResponse<T> = response.json().await.context("Failed to parse response")?;

        if !api_response.success {
            return Err(anyhow!(
                "API error: {}",
                api_response.error.unwrap_or_else(|| "Unknown error".to_string())
            ));
        }

        api_response
            .data
            .ok_or_else(|| anyhow!("No data in response"))
    }

    /// Test server connection
    pub async fn test_connection(&self) -> Result<()> {
        let url = format!("{}/health", self.base_url);
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .context("Failed to connect to server")?;

        if !response.status().is_success() {
            return Err(anyhow!("Server returned error: {}", response.status()));
        }

        Ok(())
    }

    /// Get current user info
    pub async fn get_user_info(&self) -> Result<ServerUserInfo> {
        self.get("/api/v1/users/me").await
    }

    /// Get pool members
    pub async fn get_pool(&self) -> Result<PoolResponse> {
        self.get("/api/v1/pool").await
    }

    /// Start OAuth flow
    pub async fn start_oauth(&self) -> Result<OAuthStartResponse> {
        self.post::<OAuthStartResponse, ()>("/api/v1/account/oauth/start", None)
            .await
    }

    /// Complete OAuth flow
    pub async fn complete_oauth(&self, code: &str, state: &str) -> Result<ServerAccountInfo> {
        #[derive(serde::Serialize)]
        struct CompleteOAuthRequest<'a> {
            code: &'a str,
            state: &'a str,
        }

        #[derive(serde::Deserialize)]
        struct CompleteOAuthResponse {
            account: ServerAccountInfo,
        }

        let response: CompleteOAuthResponse = self
            .post(
                "/api/v1/account/oauth/complete",
                Some(&CompleteOAuthRequest { code, state }),
            )
            .await?;

        Ok(response.account)
    }

    /// Update account settings
    pub async fn update_account(
        &self,
        is_active: Option<bool>,
        share_limit_percent: Option<i32>,
    ) -> Result<ServerAccountInfo> {
        #[derive(serde::Serialize)]
        struct UpdateAccountRequest {
            #[serde(skip_serializing_if = "Option::is_none")]
            is_active: Option<bool>,
            #[serde(skip_serializing_if = "Option::is_none")]
            share_limit_percent: Option<i32>,
        }

        self.patch(
            "/api/v1/account",
            &UpdateAccountRequest {
                is_active,
                share_limit_percent,
            },
        )
        .await
    }

    /// Unlink Anthropic account
    pub async fn unlink_account(&self) -> Result<()> {
        let url = format!("{}/api/v1/account", self.base_url);
        let response = self
            .client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await
            .context("Failed to send request")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Request failed: {} - {}", status, body));
        }

        Ok(())
    }

    /// Sync account usage
    pub async fn sync_account(&self) -> Result<ServerAccountInfo> {
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct SyncResponse {
            usage: crate::types::ServerUsageStats,
        }

        // The sync endpoint returns usage, but we want full account info
        let _: SyncResponse = self
            .post::<SyncResponse, ()>("/api/v1/account/sync", None)
            .await?;

        // Get fresh user info to get full account details
        let user_info = self.get_user_info().await?;
        user_info
            .account
            .ok_or_else(|| anyhow!("No account linked"))
    }

    /// Sync all pool members' usage
    pub async fn sync_pool(&self) -> Result<PoolResponse> {
        // Call pool sync endpoint (ignore response, we'll fetch fresh data)
        let _: serde_json::Value = self
            .post::<serde_json::Value, ()>("/api/v1/pool/sync", None)
            .await?;

        // Return fresh pool data
        self.get_pool().await
    }
}
