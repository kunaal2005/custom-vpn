const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { execFile } = require('child_process');

const configManager = require('./config-manager');
const monitor = require('./monitor');
const proxy = require('./proxy');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS lockdown - only allow the local dashboard origin
const allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('Blocked by CORS policy'), false);
    }
    return callback(null, true);
  }
}));
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

function runReg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Windows System Proxy Utility - Secured against Command Injection
async function setWindowsProxy(enabled, port = 1080) {
  if (process.platform !== 'win32') {
    console.log(`System proxy toggling is only supported on Windows. Current platform: ${process.platform}`);
    return false;
  }
  
  const cleanPort = parseInt(port, 10);
  if (isNaN(cleanPort) || cleanPort < 1024 || cleanPort > 65535) {
    console.error("Invalid port for system proxy:", port);
    return false;
  }

  try {
    if (enabled) {
      await runReg([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable',
        '/t', 'REG_DWORD',
        '/d', '1',
        '/f'
      ]);
      await runReg([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyServer',
        '/t', 'REG_SZ',
        '/d', `127.0.0.1:${cleanPort}`,
        '/f'
      ]);
    } else {
      await runReg([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable',
        '/t', 'REG_DWORD',
        '/d', '0',
        '/f'
      ]);
    }
    console.log(`Windows system proxy registry updated. Enabled: ${enabled}, Server: 127.0.0.1:${cleanPort}`);
    return true;
  } catch (err) {
    console.error("Failed to update Windows proxy registry via execFile:", err);
    return false;
  }
}

// REST API Endpoints
app.get('/api/config', (req, res) => {
  res.json(configManager.getConfig());
});

app.post('/api/settings', async (req, res) => {
  try {
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
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/nodes', (req, res) => {
  try {
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
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/nodes/:id', (req, res) => {
  try {
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
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// WebSocket Real-time updates - Secured against Cross-Site WebSocket Hijacking (CSWSH)
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    console.warn(`WebSocket connection rejected from unauthorized origin: ${origin}`);
    ws.close(4003, 'Unauthorized Origin');
    return;
  }

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
