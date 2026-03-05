const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// DOM elements
let accountsContainer;
let accountsList;
let emptyState;
let proxyStatus;
let proxyText;
let addBtn;
let syncBtn;
let settingsBtn;
let addModal;
let settingsModal;
let limitModal;

// State
let poolMembers = [];
let poolSummary = null;
let config = {};
let pendingOAuthState = null;

// Initialize app
window.addEventListener("DOMContentLoaded", async () => {
  // Get DOM elements
  accountsContainer = document.getElementById("accounts-container");
  accountsList = document.getElementById("accounts-list");
  emptyState = document.getElementById("empty-state");
  proxyStatus = document.getElementById("proxy-status");
  proxyText = document.getElementById("proxy-text");
  addBtn = document.getElementById("add-btn");
  syncBtn = document.getElementById("sync-btn");
  settingsBtn = document.getElementById("settings-btn");
  addModal = document.getElementById("add-modal");
  settingsModal = document.getElementById("settings-modal");
  limitModal = document.getElementById("limit-modal");

  // Set up event listeners
  addBtn.addEventListener("click", handleAddBtnClick);
  syncBtn.addEventListener("click", syncPool);
  settingsBtn.addEventListener("click", showSettingsModal);

  // Add modal events - Code entry (server mode only)
  document.getElementById("code-cancel").addEventListener("click", hideAddModal);
  document.getElementById("code-confirm").addEventListener("click", (e) => {
    e.preventDefault();
    submitAuthCode();
  });
  document.getElementById("auth-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAuthCode();
  });

  // Settings modal events
  document.getElementById("settings-cancel").addEventListener("click", hideSettingsModal);
  document.getElementById("settings-save").addEventListener("click", saveSettings);
  document.getElementById("test-connection").addEventListener("click", testServerConnection);

  // Limit modal events
  document.getElementById("limit-cancel").addEventListener("click", hideLimitModal);
  document.getElementById("limit-confirm").addEventListener("click", confirmShareLimit);

  // Close modals on background click
  addModal.addEventListener("click", (e) => {
    if (e.target === addModal) hideAddModal();
  });
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) hideSettingsModal();
  });
  limitModal.addEventListener("click", (e) => {
    if (e.target === limitModal) hideLimitModal();
  });

  // Listen for sync event from tray
  await listen("sync-accounts", () => {
    syncPool();
  });

  // Refresh when window becomes visible/focused
  const { getCurrentWindow } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();
  await appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      loadPool();
      updateProxyStatus();
    }
  });

  // Initial load
  await loadConfig();
  await checkServerConfig();
  await updateProxyStatus();

  // Poll for updates
  setInterval(updateProxyStatus, 5000);
  setInterval(loadPool, 30000);
});

// Check if server is configured and load pool
async function checkServerConfig() {
  const isConfigured = await invoke("is_server_mode");
  if (isConfigured) {
    await loadPool();
  } else {
    showServerNotConfigured();
  }
}

// Show message when server is not configured
function showServerNotConfigured() {
  emptyState.classList.remove("hidden");
  emptyState.innerHTML = `
    <p>Server not configured</p>
    <p class="hint">Open Settings to configure server connection</p>
  `;
  accountsList.innerHTML = "";
}

// Load pool members from server
async function loadPool() {
  try {
    console.log("Loading pool...");
    const response = await invoke("get_pool");
    console.log("Pool response:", response);
    poolMembers = response.members || [];
    poolSummary = response.summary;
    renderPool();
  } catch (e) {
    console.error("Failed to load pool:", e);
    // Check if it's a configuration error
    if (e.includes && (e.includes("not configured") || e.includes("Server not configured"))) {
      showServerNotConfigured();
    } else {
      emptyState.classList.remove("hidden");
      emptyState.innerHTML = `
        <p>Failed to load pool</p>
        <p class="hint">${escapeHtml(String(e))}</p>
      `;
      accountsList.innerHTML = "";
    }
  }
}

// Load config
async function loadConfig() {
  try {
    config = await invoke("get_config");
    console.log("Config loaded:", config);
  } catch (e) {
    console.error("Failed to load config:", e);
  }
}

// Update proxy status indicator (shows server connection status)
async function updateProxyStatus() {
  try {
    const isConfigured = await invoke("is_server_mode");
    if (isConfigured) {
      proxyStatus.classList.add("running");
      const serverUrl = config.server?.url || "Server";
      proxyText.textContent = "Connected";
    } else {
      proxyStatus.classList.remove("running");
      proxyText.textContent = "Not configured";
    }
  } catch (e) {
    proxyStatus.classList.remove("running");
    proxyText.textContent = "Error";
  }
}

// Format reset time
function formatReset(timestamp) {
  if (!timestamp) return "";
  
  // Handle string timestamps (from server)
  const resetTime = typeof timestamp === 'string' ? parseInt(timestamp, 10) * 1000 : timestamp * 1000;
  const reset = new Date(resetTime);
  const now = new Date();
  const diff = reset - now;
  
  if (diff <= 0) return "now";
  
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

// Render pool view
function renderPool() {
  console.log("Rendering pool, members:", poolMembers);
  
  // Find my account
  const myAccount = poolMembers.find(m => m.is_me);
  
  // Update add/unlink button based on account state
  if (myAccount) {
    addBtn.textContent = "Unlink Account";
    addBtn.classList.remove("btn-primary");
    addBtn.classList.add("btn-danger");
    addBtn.title = "Unlink your Anthropic account";
  } else {
    addBtn.textContent = "+ Link Account";
    addBtn.classList.add("btn-primary");
    addBtn.classList.remove("btn-danger");
    addBtn.title = "Link Anthropic account";
  }
  
  if (!poolMembers || poolMembers.length === 0) {
    emptyState.classList.remove("hidden");
    emptyState.innerHTML = `
      <p>No pool members</p>
      <p class="hint">Connect your Anthropic account to join the pool</p>
      <button class="btn btn-primary" onclick="linkAccount()" style="margin-top: 12px;">Link Account</button>
    `;
    accountsList.innerHTML = "";
    return;
  }

  emptyState.classList.add("hidden");
  
  // Sort all members by usage (lowest first)
  const allMembers = [...poolMembers].sort((a, b) => {
    const usageA = a.usage?.usage_5h ?? 0;
    const usageB = b.usage?.usage_5h ?? 0;
    return usageA - usageB;
  });

  let html = '';
  
  // My account settings section (only if linked)
  if (myAccount) {
    html += `
      <div class="pool-section">
        <h3>My Settings</h3>
        <div class="account-card my-account settings-card">
          <div class="account-header">
            <span class="account-name">${escapeHtml(myAccount.username)}</span>
            <div class="account-badges">
              ${myAccount.is_active ? '<span class="account-status active">In Pool</span>' : '<span class="account-status disabled">Not in Pool</span>'}
            </div>
          </div>
          <div class="settings-row">
            <span>Share limit: ${myAccount.share_limit_percent}%</span>
          </div>
          <div class="account-actions">
            <button onclick="toggleMyPoolAccount()">${myAccount.is_active ? 'Leave Pool' : 'Join Pool'}</button>
            <button onclick="setShareLimit()">Set Limit</button>
          </div>
        </div>
      </div>
    `;
  } else {
    html += `
      <div class="pool-section">
        <h3>My Account</h3>
        <div class="account-card no-account">
          <p>No account linked</p>
          <button class="btn btn-primary" onclick="linkAccount()">Link Anthropic Account</button>
        </div>
      </div>
    `;
  }
  
  // Pool members section (all members including self)
  const summary = poolSummary || { available: 0, total_members: 0 };
  html += `
    <div class="pool-section">
      <h3>Pool <span class="pool-stats">${summary.available}/${summary.total_members} available</span></h3>
      <div class="pool-list">
  `;
  
  if (allMembers.length === 0) {
    html += `<p class="hint">No members in the pool yet</p>`;
  }
  
  for (const member of allMembers) {
    const usage = member.usage || { usage_5h: 0, usage_7d: 0 };
    const usage5h = Math.round(usage.usage_5h * 100);
    const usage7d = Math.round(usage.usage_7d * 100);
    const reset5h = formatReset(usage.reset_5h);
    const reset7d = formatReset(usage.reset_7d);
    const isExhausted = member.is_rate_limited;
    const isLimited = member.is_active && !isExhausted && usage.usage_5h >= member.share_limit_percent / 100;
    const statusClass = member.is_rate_limited ? 'limited' : (member.is_active ? 'active' : 'inactive');
    
    html += `
      <div class="pool-item ${statusClass} ${member.is_me ? 'is-me' : ''} ${member.is_next ? 'is-next' : ''}">
        <div class="pool-item-info">
          <span class="pool-item-username">${escapeHtml(member.username)}</span>
          ${isExhausted ? '<span class="pool-item-limit limited">Exhausted</span>' : isLimited ? '<span class="pool-item-limit limited">Limited</span>' : `<span class="pool-item-limit">${member.share_limit_percent}%</span>`}

          ${!member.is_active ? '<span class="pool-item-status">Inactive</span>' : ''}
        </div>
        ${member.is_active ? `
          <div class="pool-item-usage">
            <div class="usage-bars">
              <div class="mini-bar-row">
                <span class="mini-label">5h</span>
                <div class="mini-bar">
                  <div class="mini-bar-fill bar-5h" style="width: ${usage5h}%"></div>
                </div>
                <span class="mini-percent">${usage5h}%</span>
                ${reset5h ? `<span class="mini-reset">${reset5h}</span>` : ''}
              </div>
              <div class="mini-bar-row">
                <span class="mini-label">7d</span>
                <div class="mini-bar">
                  <div class="mini-bar-fill bar-7d" style="width: ${usage7d}%"></div>
                </div>
                <span class="mini-percent">${usage7d}%</span>
                ${reset7d ? `<span class="mini-reset">${reset7d}</span>` : ''}
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  html += '</div></div>';
  accountsList.innerHTML = html;
}

// Sync pool
async function syncPool() {
  const icon = syncBtn.querySelector(".icon");
  icon.classList.add("spinning");
  syncBtn.disabled = true;
  
  try {
    // Sync all pool members' usage from Anthropic
    await invoke("server_sync_pool");
    // Then reload pool to get fresh data
    await loadPool();
  } catch (e) {
    console.error("Failed to sync:", e);
    alert("Failed to sync: " + e);
  } finally {
    icon.classList.remove("spinning");
    syncBtn.disabled = false;
  }
}

// Handle add/unlink button click
function handleAddBtnClick() {
  const myAccount = poolMembers.find(m => m.is_me);
  if (myAccount) {
    unlinkAccount();
  } else {
    linkAccount();
  }
}

// Hide add account modal
function hideAddModal() {
  addModal.classList.add("hidden");
  pendingOAuthState = null;
}

// Link Anthropic account via OAuth
window.linkAccount = async function() {
  try {
    console.log("Starting OAuth flow...");
    pendingOAuthState = await invoke("server_start_oauth");
    console.log("OAuth state:", pendingOAuthState);
    
    // Show code input modal
    addModal.classList.remove("hidden");
    document.getElementById("add-step-1").classList.add("hidden");
    document.getElementById("add-step-2").classList.remove("hidden");
    document.getElementById("auth-code").value = "";
    document.getElementById("code-confirm").disabled = false;
    document.getElementById("code-confirm").textContent = "Connect";
    document.getElementById("auth-code").focus();
  } catch (e) {
    console.error("Failed to start OAuth:", e);
    alert("Failed to start sign-in: " + e);
  }
};

// Submit authorization code
async function submitAuthCode() {
  const codeInput = document.getElementById("auth-code");
  const code = codeInput.value.trim();
  
  console.log("Submitting auth code...");
  
  if (!code) {
    codeInput.focus();
    return;
  }
  
  if (!pendingOAuthState) {
    alert("OAuth session expired. Please try again.");
    hideAddModal();
    return;
  }
  
  const confirmBtn = document.getElementById("code-confirm");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Connecting...";
  
  try {
    console.log("Calling server_complete_oauth...");
    await invoke("server_complete_oauth", {
      code: code,
      oauthState: pendingOAuthState,
    });
    console.log("OAuth completed successfully");
    hideAddModal();
    // Wait a moment for server to process, then sync and reload
    setTimeout(async () => {
      await syncPool();
    }, 500);
  } catch (e) {
    console.error("Failed to complete OAuth:", e);
    alert("Failed to connect: " + e);
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Connect";
  }
}

// Show settings modal
async function showSettingsModal() {
  await loadConfig();
  
  // Server settings
  document.getElementById("server-url").value = config.server?.url || "";
  document.getElementById("server-api-key").value = config.server?.api_key || "";
  document.getElementById("connection-status").textContent = "";
  
  settingsModal.classList.remove("hidden");
}

// Hide settings modal
function hideSettingsModal() {
  settingsModal.classList.add("hidden");
}

// Test server connection
async function testServerConnection() {
  const url = document.getElementById("server-url").value.trim();
  const apiKey = document.getElementById("server-api-key").value.trim();
  const statusEl = document.getElementById("connection-status");
  
  if (!url || !apiKey) {
    statusEl.textContent = "Enter URL and API key";
    statusEl.className = "error";
    return;
  }
  
  statusEl.textContent = "Testing...";
  statusEl.className = "";
  
  try {
    const username = await invoke("test_server_connection", { url, apiKey });
    statusEl.textContent = `Connected as ${username}`;
    statusEl.className = "success";
  } catch (e) {
    statusEl.textContent = `Failed: ${e}`;
    statusEl.className = "error";
  }
}

// Save settings
async function saveSettings() {
  const serverUrl = document.getElementById("server-url").value.trim();
  const serverApiKey = document.getElementById("server-api-key").value.trim();
  
  const newConfig = {
    auto_switch_enabled: true,
    auto_switch_threshold: 0.1,
    proxy_port: 8082,
    server: {
      enabled: !!(serverUrl && serverApiKey),
      url: serverUrl || null,
      api_key: serverApiKey || null,
    }
  };
  
  try {
    await invoke("update_config", { config: newConfig });
    config = newConfig;
    hideSettingsModal();
    
    // Reload pool with new config
    await checkServerConfig();
  } catch (e) {
    console.error("Failed to save settings:", e);
    alert("Failed to save settings: " + e);
  }
}

// Toggle my account in pool
window.toggleMyPoolAccount = async function() {
  const myAccount = poolMembers.find(m => m.is_me);
  if (!myAccount) return;
  
  try {
    await invoke("server_set_active", { isActive: !myAccount.is_active });
    await loadPool();
  } catch (e) {
    console.error("Failed to toggle pool status:", e);
    alert("Failed to update: " + e);
  }
};

// Show share limit modal
window.setShareLimit = function() {
  const myAccount = poolMembers.find(m => m.is_me);
  if (!myAccount) return;
  
  document.getElementById("share-limit-input").value = myAccount.share_limit_percent;
  limitModal.classList.remove("hidden");
  document.getElementById("share-limit-input").focus();
};

// Hide share limit modal
function hideLimitModal() {
  limitModal.classList.add("hidden");
}

// Confirm share limit
async function confirmShareLimit() {
  const input = document.getElementById("share-limit-input");
  const limitNum = parseInt(input.value, 10);
  
  if (isNaN(limitNum) || limitNum < 0 || limitNum > 100) {
    alert("Please enter a number between 0 and 100");
    return;
  }
  
  try {
    await invoke("server_set_share_limit", { shareLimitPercent: limitNum });
    hideLimitModal();
    await loadPool();
  } catch (e) {
    console.error("Failed to update share limit:", e);
    alert("Failed to update: " + e);
  }
}

// Unlink Anthropic account
window.unlinkAccount = async function() {
  if (!confirm("Are you sure you want to unlink your Anthropic account?")) {
    return;
  }
  
  try {
    await invoke("server_unlink_account");
    await loadPool();
  } catch (e) {
    console.error("Failed to unlink account:", e);
    alert("Failed to unlink: " + e);
  }
};

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
