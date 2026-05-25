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
  currentConfig = { ...currentConfig, ...newConfig };
  saveConfig();
  return currentConfig;
}

function updateSettings(newSettings) {
  currentConfig.settings = { ...currentConfig.settings, ...newSettings };
  saveConfig();
  return currentConfig;
}

function addNode(node) {
  const newNode = {
    id: 'node_' + Math.random().toString(36).substr(2, 9),
    latency: -1,
    status: 'disconnected',
    enabled: true,
    ...node
  };
  currentConfig.nodes.push(newNode);
  saveConfig();
  return newNode;
}

function updateNode(nodeId, updatedFields) {
  const nodeIndex = currentConfig.nodes.findIndex(n => n.id === nodeId);
  if (nodeIndex !== -1) {
    currentConfig.nodes[nodeIndex] = { ...currentConfig.nodes[nodeIndex], ...updatedFields };
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
