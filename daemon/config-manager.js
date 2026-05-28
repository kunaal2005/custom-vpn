const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  nodes: [
    {
      id: "node1",
      name: "VPS Tokyo (Example)",
      host: "10.0.1.1",
      port: 1080,
      country: "Japan",
      flag: "🇯🇵",
      enabled: true,
      latency: -1,
      status: "disconnected"
    },
    {
      id: "node2",
      name: "VPS Frankfurt (Example)",
      host: "10.0.2.1",
      port: 1080,
      country: "Germany",
      flag: "🇩🇪",
      enabled: true,
      latency: -1,
      status: "disconnected"
    },
    {
      id: "node3",
      name: "VPS New York (Example)",
      host: "10.0.3.1",
      port: 1080,
      country: "United States",
      flag: "🇺🇸",
      enabled: true,
      latency: -1,
      status: "disconnected"
    }
  ],
  settings: {
    mode: "racing", // "smart" (lowest latency), "racing" (parallel TCP), "static" (always use staticNodeId)
    staticNodeId: "node1",
    racingNodesCount: 3,
    localProxyPort: 1080,
    apiPort: 3001,
    systemProxyEnabled: false
  }
};

let currentConfig = null;

// Helper validation function for node data
function validateNodeData(node, isUpdate = false) {
  const errors = [];
  
  if (!isUpdate || node.name !== undefined) {
    if (typeof node.name !== 'string' || node.name.trim().length === 0 || node.name.length > 50) {
      errors.push("Invalid 'name': must be a non-empty string under 50 characters.");
    }
  }
  
  if (!isUpdate || node.host !== undefined) {
    // Validate IPv4, IPv6, or domain format
    const hostRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
    if (typeof node.host !== 'string' || !hostRegex.test(node.host)) {
      errors.push("Invalid 'host': must be a valid IP address or domain name.");
    }
  }
  
  if (!isUpdate || node.port !== undefined) {
    const port = parseInt(node.port);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push("Invalid 'port': must be a number between 1 and 65535.");
    }
  }
  
  if (!isUpdate || node.country !== undefined) {
    if (typeof node.country !== 'string' || node.country.trim().length === 0 || node.country.length > 50) {
      errors.push("Invalid 'country': must be a non-empty string under 50 characters.");
    }
  }
  
  if (node.flag !== undefined) {
    if (typeof node.flag !== 'string' || node.flag.length > 10) {
      errors.push("Invalid 'flag': must be a string representing flag emoji.");
    }
  }

  if (node.username !== undefined && node.username !== null) {
    if (typeof node.username !== 'string' || node.username.length > 100) {
      errors.push("Invalid 'username': must be a string under 100 characters.");
    }
  }

  if (node.password !== undefined && node.password !== null) {
    if (typeof node.password !== 'string' || node.password.length > 100) {
      errors.push("Invalid 'password': must be a string under 100 characters.");
    }
  }

  if (node.sshUser !== undefined && node.sshUser !== null) {
    if (typeof node.sshUser !== 'string' || node.sshUser.length > 100) {
      errors.push("Invalid 'sshUser': must be a string under 100 characters.");
    }
  }

  if (node.sshKeyPath !== undefined && node.sshKeyPath !== null) {
    if (typeof node.sshKeyPath !== 'string' || node.sshKeyPath.length > 500) {
      errors.push("Invalid 'sshKeyPath': must be a string under 500 characters.");
    }
  }

  if (node.ip !== undefined && node.ip !== null) {
    const hostRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;
    if (typeof node.ip !== 'string' || !hostRegex.test(node.ip)) {
      errors.push("Invalid 'ip': must be a valid public IP address or domain name.");
    }
  }
  
  if (node.enabled !== undefined) {
    if (typeof node.enabled !== 'boolean') {
      errors.push("Invalid 'enabled': must be a boolean.");
    }
  }
  
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

// Helper validation function for settings data
function validateSettingsData(settings) {
  const errors = [];
  
  if (settings.mode !== undefined) {
    const allowedModes = ['racing', 'smart', 'static'];
    if (!allowedModes.includes(settings.mode)) {
      errors.push(`Invalid 'mode': must be one of ${allowedModes.join(', ')}.`);
    }
  }
  
  if (settings.staticNodeId !== undefined && settings.staticNodeId !== null) {
    if (typeof settings.staticNodeId !== 'string') {
      errors.push("Invalid 'staticNodeId': must be a string.");
    }
  }
  
  if (settings.racingNodesCount !== undefined) {
    const count = parseInt(settings.racingNodesCount);
    if (isNaN(count) || count < 2 || count > 32) {
      errors.push("Invalid 'racingNodesCount': must be a number between 2 and 32.");
    }
  }
  
  if (settings.localProxyPort !== undefined) {
    const port = parseInt(settings.localProxyPort);
    if (isNaN(port) || port < 1024 || port > 65535) {
      errors.push("Invalid 'localProxyPort': must be a user port between 1024 and 65535.");
    }
  }
  
  if (settings.apiPort !== undefined) {
    const port = parseInt(settings.apiPort);
    if (isNaN(port) || port < 1024 || port > 65535) {
      errors.push("Invalid 'apiPort': must be a user port between 1024 and 65535.");
    }
  }
  
  if (settings.systemProxyEnabled !== undefined) {
    if (typeof settings.systemProxyEnabled !== 'boolean') {
      errors.push("Invalid 'systemProxyEnabled': must be a boolean.");
    }
  }
  
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      currentConfig = JSON.parse(data);
      
      // Ensure all default settings are present
      currentConfig.settings = { ...DEFAULT_CONFIG.settings, ...currentConfig.settings };
      if (!currentConfig.nodes) currentConfig.nodes = [...DEFAULT_CONFIG.nodes];
    } else {
      currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      saveConfig();
    }
  } catch (err) {
    console.error("Error loading config, using defaults:", err);
    currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  return currentConfig;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf8');
  } catch (err) {
    console.error("Error saving config:", err);
  }
}

function getConfig() {
  if (!currentConfig) {
    loadConfig();
  }
  return currentConfig;
}

function updateConfig(newConfig) {
  if (newConfig.settings) validateSettingsData(newConfig.settings);
  if (newConfig.nodes && Array.isArray(newConfig.nodes)) {
    newConfig.nodes.forEach(n => validateNodeData(n, true));
  }
  currentConfig = { ...currentConfig, ...newConfig };
  saveConfig();
  return currentConfig;
}

function updateSettings(newSettings) {
  validateSettingsData(newSettings);
  currentConfig.settings = { ...currentConfig.settings, ...newSettings };
  saveConfig();
  return currentConfig;
}

function addNode(node) {
  validateNodeData(node);
  const newNode = {
    id: 'node_' + Math.random().toString(36).substr(2, 9),
    latency: -1,
    status: 'disconnected',
    enabled: true,
    name: node.name,
    host: node.host,
    port: parseInt(node.port),
    country: node.country,
    flag: node.flag || '🌐',
    username: node.username || null,
    password: node.password || null,
    sshUser: node.sshUser || null,
    sshKeyPath: node.sshKeyPath || null,
    ip: node.ip || null
  };
  currentConfig.nodes.push(newNode);
  saveConfig();
  return newNode;
}

function updateNode(nodeId, updatedFields) {
  validateNodeData(updatedFields, true);
  const nodeIndex = currentConfig.nodes.findIndex(n => n.id === nodeId);
  if (nodeIndex !== -1) {
    // Only map known safe schema properties to prevent arbitrary property pollution
    const fields = {};
    if (updatedFields.name !== undefined) fields.name = updatedFields.name;
    if (updatedFields.host !== undefined) fields.host = updatedFields.host;
    if (updatedFields.port !== undefined) fields.port = parseInt(updatedFields.port);
    if (updatedFields.country !== undefined) fields.country = updatedFields.country;
    if (updatedFields.flag !== undefined) fields.flag = updatedFields.flag;
    if (updatedFields.username !== undefined) fields.username = updatedFields.username;
    if (updatedFields.password !== undefined) fields.password = updatedFields.password;
    if (updatedFields.sshUser !== undefined) fields.sshUser = updatedFields.sshUser;
    if (updatedFields.sshKeyPath !== undefined) fields.sshKeyPath = updatedFields.sshKeyPath;
    if (updatedFields.ip !== undefined) fields.ip = updatedFields.ip;
    if (updatedFields.enabled !== undefined) fields.enabled = updatedFields.enabled;
    if (updatedFields.status !== undefined) fields.status = updatedFields.status;
    if (updatedFields.latency !== undefined) fields.latency = updatedFields.latency;

    currentConfig.nodes[nodeIndex] = { ...currentConfig.nodes[nodeIndex], ...fields };
    saveConfig();
    return currentConfig.nodes[nodeIndex];
  }
  return null;
}

function deleteNode(nodeId) {
  const nodeIndex = currentConfig.nodes.findIndex(n => n.id === nodeId);
  if (nodeIndex !== -1) {
    const deleted = currentConfig.nodes.splice(nodeIndex, 1);
    saveConfig();
    return deleted[0];
  }
  return null;
}

module.exports = {
  getConfig,
  updateConfig,
  updateSettings,
  addNode,
  updateNode,
  deleteNode,
  loadConfig
};
