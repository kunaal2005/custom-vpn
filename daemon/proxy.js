const net = require('net');
const configManager = require('./config-manager');

let server = null;
const connectionLogs = [];
const activeConnections = new Map(); // tracks currently active sockets for UI
let logCallback = null;

// Global speed statistics
let bytesUploaded = 0;
let bytesDownloaded = 0;

// Domain to Node cache to prevent racing on every sub-request of a website
// Cache entries expire after 5 minutes
const domainRouteCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

class CancelToken {
  constructor() {
    this.cancelled = false;
    this.sockets = [];
  }
  register(socket) {
    if (this.cancelled) {
      socket.destroy();
    } else {
      this.sockets.push(socket);
    }
  }
  cancelAll() {
    this.cancelled = true;
    this.sockets.forEach(s => {
      try { s.destroy(); } catch (e) {}
    });
    this.sockets = [];
  }
}

// SOCKS5 client connection helper
function connectThroughSocks5(node, host, port, atyp, addrBuffer, cancelToken, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    
    if (cancelToken) {
      cancelToken.register(socket);
    }

    socket.setTimeout(timeout);
    
    socket.once('connect', () => {
      if (cancelToken && cancelToken.cancelled) {
        socket.destroy();
        return;
      }
      // Send SOCKS5 greeting [version, nmethods, methods]
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    let stage = 0; // 0: greeting-response, 1: connect-response
    
    socket.on('data', (data) => {
      if (cancelToken && cancelToken.cancelled) {
        socket.destroy();
        return;
      }
      
      if (stage === 0) {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          socket.destroy();
          reject(new Error('SOCKS5 auth rejected by VPS'));
          return;
        }
        
        // Send CONNECT request: [version=5, cmd=1 (CONNECT), rsv=0, atyp] + address/port buffer
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, atyp]),
          addrBuffer
        ]);
        
        stage = 1;
        socket.write(req);
      } else if (stage === 1) {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          socket.destroy();
          reject(new Error(`VPS connection failed with code: ${data[1]}`));
          return;
        }
        
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        resolve(socket);
      }
    });

    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('VPS connection timeout'));
    });

    socket.connect(node.port, node.host);
  });
}

// Log a connection event for the UI
function logConnection(host, port, node, mode, durationMs, savedMs = 0) {
  const logEntry = {
    id: Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    host,
    port,
    nodeName: node ? node.name : 'Direct / Error',
    nodeCountry: node ? node.country : 'Unknown',
    nodeFlag: node ? node.flag : '🌐',
    mode,
    durationMs,
    savedMs,
    status: 'active'
  };
  
  connectionLogs.unshift(logEntry);
  if (connectionLogs.length > 100) connectionLogs.pop(); // limit log size
  
  if (logCallback) logCallback(logEntry);
  return logEntry.id;
}

function updateLogStatus(logId, status) {
  const log = connectionLogs.find(l => l.id === logId);
  if (log) {
    log.status = status;
    if (logCallback) logCallback(log);
  }
}

// Get the best nodes for routing
function getEligibleNodes(config, settings) {
  const onlineNodes = config.nodes.filter(n => n.status === 'online');
  
  if (onlineNodes.length === 0) {
    // If no nodes are officially online, fallback to all enabled nodes to prevent total failure
    return config.nodes.filter(n => n.enabled);
  }
  return onlineNodes;
}

// Handle client requests
function handleClient(clientSocket) {
  clientSocket.once('data', (data) => {
    // SOCKS5 Greeting
    if (data[0] !== 0x05) {
      clientSocket.destroy();
      return;
    }
    
    // Accept NO AUTH (0x00)
    clientSocket.write(Buffer.from([0x05, 0x00]));
    
    clientSocket.once('readable', async () => {
      let head = clientSocket.read(4);
      if (!head) {
        clientSocket.destroy();
        return;
      }
      
      const version = head[0];
      const cmd = head[1];
      const atyp = head[3];
      
      if (version !== 0x05 || cmd !== 0x01) { // CONNECT only
        clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        clientSocket.destroy();
        return;
      }
      
      let host = '';
      let port = 0;
      let addrBuffer;
      
      if (atyp === 0x01) { // IPv4
        addrBuffer = clientSocket.read(6);
        if (!addrBuffer) { clientSocket.destroy(); return; }
        host = `${addrBuffer[0]}.${addrBuffer[1]}.${addrBuffer[2]}.${addrBuffer[3]}`;
        port = addrBuffer.readUInt16BE(4);
      } else if (atyp === 0x03) { // Domain
        const lenBuffer = clientSocket.read(1);
        if (!lenBuffer) { clientSocket.destroy(); return; }
        const len = lenBuffer[0];
        const domainBuffer = clientSocket.read(len + 2);
        if (!domainBuffer) { clientSocket.destroy(); return; }
        host = domainBuffer.slice(0, len).toString('utf8');
        port = domainBuffer.readUInt16BE(len);
        addrBuffer = Buffer.concat([lenBuffer, domainBuffer]);
      } else if (atyp === 0x04) { // IPv6
        addrBuffer = clientSocket.read(18);
        if (!addrBuffer) { clientSocket.destroy(); return; }
        host = 'IPv6_Destination';
        port = addrBuffer.readUInt16BE(16);
      } else {
        clientSocket.destroy();
        return;
      }
      
      const config = configManager.getConfig();
      const settings = config.settings;
      const eligibleNodes = getEligibleNodes(config, settings);
      
      if (eligibleNodes.length === 0) {
        console.error("No VPN nodes configured or enabled.");
        clientSocket.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
        clientSocket.destroy();
        return;
      }
      
      const startTime = Date.now();
      let logId = null;
      
      // Determine Routing Method
      let selectedNode = null;
      let useRacing = false;
      
      // 1. Check domain cache for stable routing sessions
      const cached = domainRouteCache.get(host);
      if (cached && cached.expiry > Date.now()) {
        selectedNode = config.nodes.find(n => n.id === cached.nodeId && n.status === 'online');
      }
      
      if (!selectedNode) {
        if (settings.mode === 'static') {
          selectedNode = config.nodes.find(n => n.id === settings.staticNodeId && n.status === 'online') || eligibleNodes[0];
        } else if (settings.mode === 'smart') {
          // Sort by latency (lowest first)
          const sorted = [...eligibleNodes].sort((a, b) => {
            if (a.latency <= 0) return 1;
            if (b.latency <= 0) return -1;
            return a.latency - b.latency;
          });
          selectedNode = sorted[0];
        } else if (settings.mode === 'racing') {
          useRacing = true;
        }
      }
      
      if (useRacing) {
        // Race the top N lowest latency nodes
        const sorted = [...eligibleNodes]
          .filter(n => n.latency > 0)
          .sort((a, b) => a.latency - b.latency);
          
        const raceNodes = sorted.slice(0, settings.racingNodesCount);
        
        if (raceNodes.length <= 1) {
          // Fallback if only 1 node is online/valid
          selectedNode = raceNodes[0] || eligibleNodes[0];
          useRacing = false;
        } else {
          const cancelToken = new CancelToken();
          const raceStartTime = Date.now();
          const nodeTimes = new Map(); // record individual socket connect times for dashboard optimization calculations
          
          const promises = raceNodes.map(node => {
            const nodeStart = Date.now();
            return connectThroughSocks5(node, host, port, atyp, addrBuffer, cancelToken, 4000)
              .then(socket => {
                nodeTimes.set(node.id, Date.now() - nodeStart);
                return { node, socket };
              })
              .catch(err => {
                nodeTimes.set(node.id, 9999);
                throw err;
              });
          });
          
          try {
            // Wait for the first successful connection
            const winner = await Promise.any(promises);
            const duration = Date.now() - raceStartTime;
            
            // Cancel other ongoing handshakes immediately!
            cancelToken.cancelAll();
            
            const winningNode = winner.node;
            const winningSocket = winner.socket;
            
            // Calculate saving: (max latency among other racing nodes or average latency) - winner latency
            let maxLatency = 0;
            nodeTimes.forEach((time, id) => {
              if (id !== winningNode.id && time < 9999 && time > maxLatency) {
                maxLatency = time;
              }
            });
            const savedMs = maxLatency > 0 ? Math.max(0, maxLatency - duration) : 0;
            
            logId = logConnection(host, port, winningNode, 'racing', duration, savedMs);
            
            // Cache the winning node for this domain
            domainRouteCache.set(host, {
              nodeId: winningNode.id,
              expiry: Date.now() + CACHE_TTL
            });
            
            // Write success response to client
            clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
            
            // Speed tracking
            clientSocket.on('data', (chunk) => { bytesUploaded += chunk.length; });
            winningSocket.on('data', (chunk) => { bytesDownloaded += chunk.length; });

            // Bind sockets together
            clientSocket.pipe(winningSocket);
            winningSocket.pipe(clientSocket);
            
            const connId = Math.random().toString(36).substr(2, 9);
            activeConnections.set(connId, { client: clientSocket, remote: winningSocket });
            
            const cleanup = () => {
              activeConnections.delete(connId);
              updateLogStatus(logId, 'closed');
              try { clientSocket.destroy(); } catch(e) {}
              try { winningSocket.destroy(); } catch(e) {}
            };
            
            clientSocket.on('close', cleanup);
            winningSocket.on('close', cleanup);
            clientSocket.on('error', cleanup);
            winningSocket.on('error', cleanup);
            
          } catch (err) {
            // All racing attempts failed
            cancelToken.cancelAll();
            logConnection(host, port, null, 'racing_failed', Date.now() - startTime);
            clientSocket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
            clientSocket.destroy();
          }
        }
      }
      
      // Standard connection (Non-racing)
      if (!useRacing && selectedNode) {
        try {
          const remoteSocket = await connectThroughSocks5(selectedNode, host, port, atyp, addrBuffer, null, 5000);
          const duration = Date.now() - startTime;
          
          logId = logConnection(host, port, selectedNode, settings.mode, duration, 0);
          
          // Write success response to client
          clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
          
          // Speed tracking
          clientSocket.on('data', (chunk) => { bytesUploaded += chunk.length; });
          remoteSocket.on('data', (chunk) => { bytesDownloaded += chunk.length; });

          clientSocket.pipe(remoteSocket);
          remoteSocket.pipe(clientSocket);
          
          const connId = Math.random().toString(36).substr(2, 9);
          activeConnections.set(connId, { client: clientSocket, remote: remoteSocket });
          
          const cleanup = () => {
            activeConnections.delete(connId);
            updateLogStatus(logId, 'closed');
            try { clientSocket.destroy(); } catch(e) {}
            try { remoteSocket.destroy(); } catch(e) {}
          };
          
          clientSocket.on('close', cleanup);
          remoteSocket.on('close', cleanup);
          clientSocket.on('error', cleanup);
          remoteSocket.on('error', cleanup);
          
        } catch (err) {
          logConnection(host, port, null, 'failed', Date.now() - startTime);
          clientSocket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
          clientSocket.destroy();
        }
      }
    });
  });
}

function start(port = 1080) {
  return new Promise((resolve, reject) => {
    server = net.createServer(handleClient);
    
    server.on('error', (err) => {
      console.error(`SOCKS5 Proxy server error:`, err);
      reject(err);
    });
    
    server.listen(port, '127.0.0.1', () => {
      console.log(`Intelligent SOCKS5 Proxy Server listening on 127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log("SOCKS5 Proxy Server stopped");
        // Close all active connections
        activeConnections.forEach(conn => {
          try { conn.client.destroy(); } catch(e) {}
          try { conn.remote.destroy(); } catch(e) {}
        });
        activeConnections.clear();
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function onLog(callback) {
  logCallback = callback;
}

function getConnectionLogs() {
  return connectionLogs;
}

function getSpeedStats() {
  const current = { bytesUploaded, bytesDownloaded };
  // Reset counters for next second delta calculation
  bytesUploaded = 0;
  bytesDownloaded = 0;
  return current;
}

module.exports = {
  start,
  stop,
  onLog,
  getConnectionLogs,
  getSpeedStats,
  activeConnections
};
