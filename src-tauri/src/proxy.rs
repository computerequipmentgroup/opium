//! HTTP proxy server - forwards requests to the configured pool server

use crate::state::SharedState;
use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, Method, Request, Response, StatusCode},
    routing::any,
    Router,
};
use std::net::SocketAddr;
use tokio::sync::oneshot;
use tracing::{debug, error, info};

/// Proxy request handler - forwards to the configured server
async fn proxy_handler(
    State(state): State<SharedState>,
    req: Request<Body>,
) -> Result<Response<Body>, (StatusCode, String)> {
    // Get server config
    let config = state.get_config();
    let server_config = &config.server;
    
    if !server_config.is_configured() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Server not configured. Open settings to configure the pool server.".to_string(),
        ));
    }
    
    let server_url = server_config.url.as_ref().unwrap();
    let api_key = server_config.api_key.as_ref().unwrap();

    // Build the proxied request
    let (parts, body) = req.into_parts();
    let uri = parts.uri.clone();

    // Construct target URL
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("{}{}", server_url, path_and_query);

    debug!("Proxying {} {} -> {}", parts.method, uri, target_url);

    // Build reqwest request
    let client = reqwest::Client::new();
    let mut request_builder = match parts.method {
        Method::GET => client.get(&target_url),
        Method::POST => client.post(&target_url),
        Method::PUT => client.put(&target_url),
        Method::DELETE => client.delete(&target_url),
        Method::PATCH => client.patch(&target_url),
        _ => client.request(parts.method.clone(), &target_url),
    };

    // Copy headers, but replace Authorization/x-api-key with our server API key
    for (name, value) in parts.headers.iter() {
        if name == header::HOST 
            || name == header::AUTHORIZATION 
            || name.as_str().eq_ignore_ascii_case("x-api-key") 
        {
            continue;
        }
        if let Ok(v) = value.to_str() {
            request_builder = request_builder.header(name.as_str(), v);
        }
    }

    // Add server API key for authentication
    request_builder = request_builder.header("Authorization", format!("Bearer {}", api_key));

    // Add body if present
    let body_bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Failed to read body: {}", e)))?;

    if !body_bytes.is_empty() {
        request_builder = request_builder.body(body_bytes.to_vec());
    }

    // Send the request to the server
    let response = request_builder.send().await.map_err(|e| {
        error!("Proxy request to server failed: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to connect to pool server: {}", e),
        )
    })?;

    let status = response.status();
    let headers = response.headers().clone();

    // Increment request counter
    state.increment_requests();

    // Build response
    let response_bytes = response.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read response from server: {}", e),
        )
    })?;

    let mut builder = Response::builder().status(status);

    // Copy response headers
    for (name, value) in headers.iter() {
        if name == header::TRANSFER_ENCODING || name == header::CONNECTION {
            continue;
        }
        if let Ok(hv) = HeaderValue::from_bytes(value.as_bytes()) {
            builder = builder.header(name, hv);
        }
    }

    builder
        .body(Body::from(response_bytes.to_vec()))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build response: {}", e),
            )
        })
}

/// Health check endpoint
async fn health_handler(State(state): State<SharedState>) -> &'static str {
    state.increment_requests();
    "OK"
}

/// Status endpoint (returns JSON)
async fn status_handler(State(state): State<SharedState>) -> axum::Json<serde_json::Value> {
    let proxy_status = state.get_proxy_status();
    let config = state.get_config();

    axum::Json(serde_json::json!({
        "status": "running",
        "server_configured": config.server.is_configured(),
        "server_url": config.server.url,
        "requests_proxied": proxy_status.requests_proxied
    }))
}

/// Proxy server handle for shutdown
#[allow(dead_code)]
pub struct ProxyServer {
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl ProxyServer {
    #[allow(dead_code)]
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Start the proxy server
pub async fn start_proxy(state: SharedState) -> Result<ProxyServer> {
    let port = state.get_proxy_port();
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;

    let app = Router::new()
        .route("/health", any(health_handler))
        .route("/status", any(status_handler))
        .fallback(any(proxy_handler))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .context(format!("Failed to bind to port {}", port))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    state.set_proxy_running(true);
    info!("Proxy server started on http://127.0.0.1:{}", port);

    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                shutdown_rx.await.ok();
            })
            .await
            .ok();

        state.set_proxy_running(false);
        info!("Proxy server stopped");
    });

    Ok(ProxyServer {
        shutdown_tx: Some(shutdown_tx),
    })
}
