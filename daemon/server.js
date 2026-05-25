const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { exec } = require('child_process');

const configManager = require('./config-manager');
const monitor = require('./monitor');
const proxy = require('./proxy');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const config = configManager.loadConfig();
let activeClients = new Set();

// SOCKS5 Proxy Management
let proxyPort = config.settings.localProxyPort || 1080;
proxy.start(proxyPort)
  .then(() => console.log(`Proxy listening successfully on port ${proxyPort}`))
  .catch(err => console.error("Could not start SOCKS5 proxy:", err));

// Start Node Latency Monitor
monitor.start(8000);

// Notify WebSocket Clients on Monitor Updates
monitor.onChange((updatedNodes) => {
  broadcast({
    type: 'nodes_update',
    nodes: updatedNodes
  });
});

// Notify WebSocket Clients on proxy logs
proxy.onLog((logEntry) => {
  broadcast({
    type: 'log_entry',
    log: logEntry
  });
});

// Windows System Proxy Utility
function setWindowsProxy(enabled, port = 1080) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      console.log(`System proxy toggling is only supported on Windows. Current platform: ${process.platform}`);
      return resolve(false);
    }
    
    const enableVal = enabled ? 1 : 0;
    const serverVal = `127.0.0.1:${port}`;
    
    const cmd = enabled 
      ? `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f && reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${serverVal}" /f`
      : `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`;
      
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error("Failed to update Windows proxy registry:", err);
        return resolve(false);
      }
      console.log(`Windows system proxy registry updated. Enabled: ${enabled}, Server: ${serverVal}`);
      resolve(true);
    });
  });
}

// REST API Endpoints
app.get('/api/config', (req, res) => {
  res.json(configManager.getConfig());
});

app.post('/api/settings', async (req, res) => {
  const currentConfig = configManager.getConfig();
  const oldPort = currentConfig.settings.localProxyPort;
  const oldSystemProxy = currentConfig.settings.systemProxyEnabled;
  
  const newConfig = configManager.updateSettings(req.body);
  const newPort = newConfig.settings.localProxyPort;
  const newSystemProxy = newConfig.settings.systemProxyEnabled;
  
  // Restart SOCKS5 Proxy if port changed
  if (oldPort !== newPort) {
    try {
      await proxy.stop();
      await proxy.start(newPort);
      proxyPort = newPort;
      console.log(`SOCKS5 Proxy restarted on new port: ${newPort}`);
    } catch (err) {
      console.error(`Failed to restart proxy on port ${newPort}:`, err);
    }
  }

  // Update Windows System Proxy if setting toggled or port changed
  if (oldSystemProxy !== newSystemProxy || (newSystemProxy && oldPort !== newPort)) {
    await setWindowsProxy(newSystemProxy, newPort);
  }
  
  broadcast({
    type: 'config_update',
    config: newConfig
  });
  
  res.json(newConfig);
});

app.post('/api/nodes', (req, res) => {
  const newNode = configManager.addNode(req.body);
  broadcast({
    type: 'nodes_list_update',
    nodes: configManager.getConfig().nodes
  });
  // Trigger immediate check for new node
  monitor.checkNode(newNode).then(checked => {
    configManager.updateNode(newNode.id, {
      status: checked.status,
      latency: checked.latency
    });
    broadcast({
      type: 'nodes_list_update',
      nodes: configManager.getConfig().nodes
    });
  });
  res.json(newNode);
});

app.put('/api/nodes/:id', (req, res) => {
  const updated = configManager.updateNode(req.params.id, req.body);
  if (updated) {
    broadcast({
      type: 'nodes_list_update',
      nodes: configManager.getConfig().nodes
    });
    res.json(updated);
  } else {
    res.status(404).json({ error: "Node not found" });
  }
});

app.delete('/api/nodes/:id', (req, res) => {
  const deleted = configManager.deleteNode(req.params.id);
  if (deleted) {
    broadcast({
      type: 'nodes_list_update',
      nodes: configManager.getConfig().nodes
    });
    res.json(deleted);
  } else {
    res.status(404).json({ error: "Node not found" });
  }
});

app.get('/api/logs', (req, res) => {
  res.json(proxy.getConnectionLogs());
});

app.post('/api/test-node/:id', async (req, res) => {
  const nodes = configManager.getConfig().nodes;
  const node = nodes.find(n => n.id === req.params.id);
  if (!node) {
    return res.status(404).json({ error: "Node not found" });
  }
  
  const checked = await monitor.checkNode(node);
  configManager.updateNode(node.id, {
    status: checked.status,
    latency: checked.latency
  });
  
  broadcast({
    type: 'nodes_list_update',
    nodes: configManager.getConfig().nodes
  });
  
  res.json(checked);
});

// WebSocket Real-time updates
wss.on('connection', (ws) => {
  activeClients.add(ws);
  
  // Send initial data
  ws.send(JSON.stringify({
    type: 'init',
    config: configManager.getConfig(),
    logs: proxy.getConnectionLogs()
  }));
  
  ws.on('close', () => {
    activeClients.delete(ws);
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  activeClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Bandwidth stats reporting (every 1 second)
setInterval(() => {
  if (activeClients.size > 0) {
    const stats = proxy.getSpeedStats();
    
    // Calculate current active connections count
    const activeConnsCount = proxy.activeConnections.size;
    
    broadcast({
      type: 'stats_update',
      uploadSpeed: stats.bytesUploaded, // bytes per second
      downloadSpeed: stats.bytesDownloaded, // bytes per second
      activeConnections: activeConnsCount
    });
  }
}, 1000);

// Cleanup on shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function shutdown() {
  console.log("Shutting down daemon...");
  monitor.stop();
  
  // Disable Windows Proxy on exit if it was enabled
  const currentConfig = configManager.getConfig();
  if (currentConfig.settings.systemProxyEnabled) {
    console.log("Disabling Windows system proxy on exit...");
    await setWindowsProxy(false);
  }
  
  await proxy.stop();
  server.close(() => {
    console.log("Express API Server stopped");
    process.exit(0);
  });
}

const PORT = config.settings.apiPort || 3001;
server.listen(PORT, () => {
  console.log(`Control Panel API Server running on port ${PORT}`);
});
