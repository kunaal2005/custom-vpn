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
const PORT = config.settings.apiPort || 3001;
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
        '/d', '0',
        '/f'
      ]);
      await runReg([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'AutoConfigURL',
        '/t', 'REG_SZ',
        '/d', `http://127.0.0.1:${PORT}/proxy.pac`,
        '/f'
      ]);
      console.log(`Windows system proxy enabled using PAC file: http://127.0.0.1:${PORT}/proxy.pac`);
    } else {
      await runReg([
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyEnable',
        '/t', 'REG_DWORD',
        '/d', '0',
        '/f'
      ]);
      try {
        await runReg([
          'delete',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          '/v', 'AutoConfigURL',
          '/f'
        ]);
      } catch (err) {
        // Ignore if AutoConfigURL didn't exist
      }
      console.log("Windows system proxy disabled (PAC auto-config removed).");
    }
    return true;
  } catch (err) {
    console.error("Failed to update Windows proxy registry via execFile:", err);
    return false;
  }
}

// Remote SSH Service Control helper using execFile
function controlRemoteService(node, action) {
  return new Promise((resolve) => {
    if (!node.sshUser || !node.sshKeyPath || !node.ip) {
      console.log(`Skipping remote service control for node ${node.id} (${node.name || 'unnamed'}): Missing SSH details.`);
      return resolve({ success: true, node });
    }

    const sshArgs = [
      '-i', node.sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      `${node.sshUser}@${node.ip}`,
      `sudo systemctl ${action} vpn-socks5`
    ];

    console.log(`Executing remote SSH action (${action}) on node ${node.id} (${node.ip})...`);
    execFile('ssh', sshArgs, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`Remote service control failed for node ${node.id}:`, err.message || err);
        return resolve({ success: false, node, error: err });
      }
      console.log(`Successfully completed remote service (${action}) on node ${node.id}.`);
      resolve({ success: true, node });
    });
  });
}

// Control all remote services for active nodes
async function controlAllActiveRemoteServices(action) {
  const currentConfig = configManager.getConfig();
  const activeNodes = currentConfig.nodes.filter(n => n.enabled);
  
  console.log(`Triggering remote service action (${action}) on ${activeNodes.length} active nodes...`);
  
  const promises = activeNodes.map(node => controlRemoteService(node, action));
  const results = await Promise.all(promises);
  return results;
}

// Proxy Auto-Configuration (PAC) endpoint to force SOCKS5 in Windows
app.get('/proxy.pac', (req, res) => {
  res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig');
  res.send(`
    function FindProxyForURL(url, host) {
      if (host === "localhost" || 
          host === "127.0.0.1" || 
          host === "[::1]" || 
          host === "::1" || 
          shExpMatch(host, "10.*") || 
          shExpMatch(host, "172.16.*") || 
          shExpMatch(host, "172.17.*") || 
          shExpMatch(host, "172.18.*") || 
          shExpMatch(host, "172.19.*") || 
          shExpMatch(host, "172.20.*") || 
          shExpMatch(host, "172.21.*") || 
          shExpMatch(host, "172.22.*") || 
          shExpMatch(host, "172.23.*") || 
          shExpMatch(host, "172.24.*") || 
          shExpMatch(host, "172.25.*") || 
          shExpMatch(host, "172.26.*") || 
          shExpMatch(host, "172.27.*") || 
          shExpMatch(host, "172.28.*") || 
          shExpMatch(host, "172.29.*") || 
          shExpMatch(host, "172.30.*") || 
          shExpMatch(host, "172.31.*") || 
          shExpMatch(host, "192.168.*") || 
          isPlainHostName(host)) {
        return "DIRECT";
      }
      return "SOCKS5 127.0.0.1:${proxyPort}; DIRECT";
    }
  `);
});

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

    // Update Windows System Proxy and remote nodes if setting toggled or port changed
    if (oldSystemProxy !== newSystemProxy || (newSystemProxy && oldPort !== newPort)) {
      if (newSystemProxy) {
        // Toggled ON: Start remote services first, then set Windows proxy
        await controlAllActiveRemoteServices('start');
        await setWindowsProxy(newSystemProxy, newPort);
      } else {
        // Toggled OFF: Disable Windows proxy first, but keep remote SOCKS5 services running for local proxy
        await setWindowsProxy(newSystemProxy, newPort);
      }
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
  
  // Stop all active remote SOCKS5 proxies
  await controlAllActiveRemoteServices('stop');
  
  await proxy.stop();
  server.close(() => {
    console.log("Express API Server stopped");
    process.exit(0);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[CRITICAL ERROR] Port ${PORT} is already in use by another process.`);
    console.error(`Please verify if another instance of the VPN daemon is running, or modify 'apiPort' in 'daemon/config.json'.`);
  } else {
    console.error(`\n[CRITICAL ERROR] Control Panel API Server error:`, err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Control Panel API Server running on port ${PORT}`);
  // Start remote services for all active nodes on boot
  controlAllActiveRemoteServices('start')
    .then(() => console.log("All remote SOCKS5 services started on boot."))
    .catch(err => console.error("Failed to start remote SOCKS5 services on boot:", err));
});
