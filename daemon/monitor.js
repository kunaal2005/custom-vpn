const net = require('net');
const configManager = require('./config-manager');

let monitorInterval = null;
const listeners = [];

// Lightweight TCP ping to measure RTT to the node's SOCKS5 proxy port
function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const start = process.hrtime();
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.once('connect', () => {
      const diff = process.hrtime(start);
      const ms = diff[0] * 1000 + diff[1] / 1000000;
      socket.destroy();
      resolve(Math.round(ms));
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(-1);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(-1);
    });

    socket.connect(port, host);
  });
}

// Check a single node
async function checkNode(node) {
  if (!node.enabled) {
    return { ...node, status: 'disabled', latency: -1 };
  }

  try {
    const latency = await tcpPing(node.host, node.port);
    const status = latency > 0 ? 'online' : 'offline';
    return { ...node, status, latency };
  } catch (err) {
    return { ...node, status: 'offline', latency: -1 };
  }
}

// Run latency check for all enabled nodes
async function runChecks() {
  const config = configManager.getConfig();
  const updatedNodes = [];

  for (const node of config.nodes) {
    const checked = await checkNode(node);
    configManager.updateNode(node.id, {
      status: checked.status,
      latency: checked.latency
    });
    updatedNodes.push(checked);
  }

  // Notify listeners
  listeners.forEach(cb => cb(updatedNodes));
}

// Start the monitor background loop
function start(intervalMs = 8000) {
  if (monitorInterval) clearInterval(monitorInterval);
  
  // Run immediately on start
  runChecks();
  
  monitorInterval = setInterval(runChecks, intervalMs);
  console.log(`Latency Monitor started: polling nodes every ${intervalMs / 1000}s`);
}

function stop() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log("Latency Monitor stopped");
  }
}

function onChange(callback) {
  listeners.push(callback);
}

module.exports = {
  start,
  stop,
  onChange,
  checkNode,
  runChecks
};
