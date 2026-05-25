import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const API_BASE = 'http://localhost:3001/api';
const WS_URL = 'ws://localhost:3001';

export default function App() {
  const [config, setConfig] = useState(null);
  const [logs, setLogs] = useState([]);
  const [activeConnections, setActiveConnections] = useState(0);
  const [speeds, setSpeeds] = useState({ upload: 0, download: 0 });
  const [speedHistory, setSpeedHistory] = useState([]); // for SVG charts
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingNode, setEditingNode] = useState(null);
  const [formData, setFormData] = useState({ name: '', host: '', port: 1080, country: '', flag: '🌐' });
  const [totalSavedMs, setTotalSavedMs] = useState(0);
  const [totalOptimizations, setTotalOptimizations] = useState(0);
  const [statusText, setStatusText] = useState('Disconnected');

  const wsRef = useRef(null);

  useEffect(() => {
    // Load initial config and logs
    fetchConfig();
    fetchLogs();

    // Setup WebSocket
    connectWS();

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Calculate accumulated savings
  useEffect(() => {
    if (logs.length > 0) {
      const racingLogs = logs.filter(l => l.mode === 'racing' || l.savedMs > 0);
      const totalSaved = racingLogs.reduce((acc, curr) => acc + (curr.savedMs || 0), 0);
      setTotalSavedMs(totalSaved);
      setTotalOptimizations(racingLogs.length);
    }
  }, [logs]);

  const connectWS = () => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatusText('Dashboard Synced');
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'init':
          setConfig(data.config);
          setLogs(data.logs);
          break;
        case 'config_update':
          setConfig(data.config);
          break;
        case 'nodes_update':
        case 'nodes_list_update':
          setConfig(prev => prev ? { ...prev, nodes: data.nodes } : null);
          break;
        case 'log_entry':
          setLogs(prev => {
            const index = prev.findIndex(l => l.id === data.log.id);
            if (index !== -1) {
              const updated = [...prev];
              updated[index] = data.log;
              return updated;
            } else {
              return [data.log, ...prev].slice(0, 100);
            }
          });
          break;
        case 'stats_update':
          setSpeeds({ upload: data.uploadSpeed, download: data.downloadSpeed });
          setActiveConnections(data.activeConnections);
          
          setSpeedHistory(prev => {
            const next = [...prev, {
              time: Date.now(),
              upload: data.uploadSpeed / 1024, // KB/s
              download: data.downloadSpeed / 1024 // KB/s
            }];
            return next.slice(-40); // keep last 40 seconds
          });
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      setStatusText('Dashboard Reconnecting...');
      setTimeout(connectWS, 2000);
    };
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/config`);
      const data = await res.json();
      setConfig(data);
    } catch (e) {
      console.error("Failed to fetch config:", e);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch(`${API_BASE}/logs`);
      const data = await res.json();
      setLogs(data);
    } catch (e) {
      console.error("Failed to fetch logs:", e);
    }
  };

  const handleToggleSystemProxy = async () => {
    if (!config) return;
    const nextEnabled = !config.settings.systemProxyEnabled;
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemProxyEnabled: nextEnabled })
      });
      const updated = await res.json();
      setConfig(updated);
    } catch (e) {
      console.error("Failed to toggle system proxy:", e);
    }
  };

  const handleModeChange = async (mode) => {
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const updated = await res.json();
      setConfig(updated);
    } catch (e) {
      console.error("Failed to change mode:", e);
    }
  };

  const handleStaticNodeChange = async (staticNodeId) => {
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staticNodeId })
      });
      const updated = await res.json();
      setConfig(updated);
    } catch (e) {
      console.error("Failed to change static node:", e);
    }
  };

  const handleRacingNodesCountChange = async (count) => {
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ racingNodesCount: parseInt(count) })
      });
      const updated = await res.json();
      setConfig(updated);
    } catch (e) {
      console.error("Failed to update racing count:", e);
    }
  };

  const handleNodeToggle = async (nodeId, enabled) => {
    try {
      await fetch(`${API_BASE}/nodes/${nodeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
    } catch (e) {
      console.error("Failed to toggle node:", e);
    }
  };

  const handleTestNode = async (nodeId, e) => {
    e.stopPropagation();
    try {
      setStatusText(`Pinging Node...`);
      await fetch(`${API_BASE}/test-node/${nodeId}`, { method: 'POST' });
      setStatusText(`Dashboard Synced`);
    } catch (e) {
      console.error("Failed to test node:", e);
      setStatusText(`Ping Failed`);
    }
  };

  const handleDeleteNode = async (nodeId, e) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this node?")) return;
    try {
      await fetch(`${API_BASE}/nodes/${nodeId}`, { method: 'DELETE' });
    } catch (e) {
      console.error("Failed to delete node:", e);
    }
  };

  const handleAddOrEditNode = async (e) => {
    e.preventDefault();
    try {
      if (editingNode) {
        await fetch(`${API_BASE}/nodes/${editingNode.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
      } else {
        await fetch(`${API_BASE}/nodes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
      }
      setShowAddModal(false);
      setEditingNode(null);
      setFormData({ name: '', host: '', port: 1080, country: '', flag: '🌐' });
    } catch (e) {
      console.error("Failed to save node:", e);
    }
  };

  const openEditModal = (node, e) => {
    e.stopPropagation();
    setEditingNode(node);
    setFormData({
      name: node.name,
      host: node.host,
      port: node.port,
      country: node.country,
      flag: node.flag || '🌐'
    });
    setShowAddModal(true);
  };

  const formatSpeed = (bytesPerSec) => {
    if (bytesPerSec === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (!config) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Connecting to Antigravity VPN Gateway...</p>
      </div>
    );
  }

  // Calculate max download speed in history to scale chart
  const maxDownloadHistory = Math.max(...speedHistory.map(h => h.download), 10);
  const maxUploadHistory = Math.max(...speedHistory.map(h => h.upload), 10);

  // Generate SVG paths for speed sparklines
  const buildSvgPath = (dataKey, maxVal) => {
    if (speedHistory.length < 2) return '';
    const width = 500;
    const height = 120;
    const padding = 10;
    
    const points = speedHistory.map((item, idx) => {
      const x = (idx / (speedHistory.length - 1)) * (width - 2 * padding) + padding;
      const val = item[dataKey];
      // invert Y coordinate for SVG
      const y = height - padding - (val / maxVal) * (height - 2 * padding);
      return `${x},${y}`;
    });
    
    return `M ${points.join(' L ')}`;
  };

  return (
    <div className="app-container">
      {/* BACKGROUND EFFECTS */}
      <div className="glow-sphere glow-sphere-1"></div>
      <div className="glow-sphere glow-sphere-2"></div>

      {/* HEADER */}
      <header className="app-header">
        <div className="header-brand">
          <div className="logo-icon">▲</div>
          <div>
            <h1>ANTIGRAVITY VPN</h1>
            <p className="subtitle">Multi-Node Intelligent Routing Gateway</p>
          </div>
        </div>
        <div className="header-status">
          <span className={`status-badge ${config.settings.systemProxyEnabled ? 'active' : 'inactive'}`}>
            {config.settings.systemProxyEnabled ? 'SYSTEM ROUTING ACTIVE' : 'LOCAL ROUTING ONLY'}
          </span>
          <span className="sync-status">
            <span className="pulse-dot"></span>
            {statusText}
          </span>
        </div>
      </header>

      {/* DASHBOARD GRID */}
      <main className="dashboard-grid">
        
        {/* ROW 1: CONTROLS & METERS */}
        <section className="dashboard-row card-group-2">
          
          {/* CONTROL PANEL CARD */}
          <div className="glass-card main-switch-card">
            <h2>SYSTEM VPN STATE</h2>
            <div className="toggle-container">
              <button 
                className={`power-toggle ${config.settings.systemProxyEnabled ? 'active' : ''}`}
                onClick={handleToggleSystemProxy}
              >
                <div className="power-inner">
                  <span className="power-symbol">⏻</span>
                </div>
              </button>
              <div className="toggle-info">
                <h3>{config.settings.systemProxyEnabled ? 'CONNECTED' : 'DISCONNECTED'}</h3>
                <p>
                  {config.settings.systemProxyEnabled 
                    ? 'Windows system-wide SOCKS5 routing is active. All supported applications are tunneled.'
                    : 'System proxy disabled. Set your browser or tools to SOCKS5 127.0.0.1:1080 to route traffic.'}
                </p>
              </div>
            </div>

            <div className="routing-efficiency-bar">
              <div className="efficiency-metric">
                <span className="efficiency-val">{totalOptimizations}</span>
                <span className="efficiency-label">TCP Handshakes Tuned</span>
              </div>
              <div className="efficiency-divider"></div>
              <div className="efficiency-metric">
                <span className="efficiency-val">{(totalSavedMs / 1000).toFixed(2)}s</span>
                <span className="efficiency-label">Latency Saved (Racing)</span>
              </div>
            </div>
          </div>

          {/* REALTIME SPEEDOMETER CARD */}
          <div className="glass-card speed-card">
            <div className="card-header-with-actions">
              <h2>BANDWIDTH THROUGHPUT</h2>
              <div className="active-count-tag">
                {activeConnections} active connections
              </div>
            </div>
            
            <div className="speeds-display">
              <div className="speed-stat down">
                <div className="speed-label">▼ DOWNLOAD</div>
                <div className="speed-value">{formatSpeed(speeds.download)}</div>
              </div>
              <div className="speed-divider"></div>
              <div className="speed-stat up">
                <div className="speed-label">▲ UPLOAD</div>
                <div className="speed-value">{formatSpeed(speeds.upload)}</div>
              </div>
            </div>

            <div className="speed-chart-container">
              <svg viewBox="0 0 500 120" className="speed-svg">
                {/* Download Path */}
                <path 
                  d={buildSvgPath('download', maxDownloadHistory)} 
                  fill="none" 
                  stroke="#10b981" 
                  strokeWidth="2.5" 
                  strokeLinecap="round"
                  className="chart-path-download"
                />
                {/* Upload Path */}
                <path 
                  d={buildSvgPath('upload', maxUploadHistory)} 
                  fill="none" 
                  stroke="#8b5cf6" 
                  strokeWidth="1.5" 
                  strokeLinecap="round"
                  className="chart-path-upload"
                />
              </svg>
            </div>
          </div>
        </section>

        {/* ROW 2: ROUTING MODES & NODES */}
        <section className="dashboard-row card-group-2">
          
          {/* ROUTING MODES CARD */}
          <div className="glass-card modes-card">
            <h2>ROUTING OPTIMIZATION OPTIONS</h2>
            
            <div className="modes-list">
              <div 
                className={`mode-option ${config.settings.mode === 'racing' ? 'active' : ''}`}
                onClick={() => handleModeChange('racing')}
              >
                <div className="mode-radio"></div>
                <div className="mode-details">
                  <h3>Handshake Racing Mode (3-Way Optimization)</h3>
                  <p>Launches parallel connection handshakes through multiple VPS nodes. Connects to the website through the fastest responder instantly, killing the other attempts. Maximum geoblock bypass and minimum load delays.</p>
                  
                  {config.settings.mode === 'racing' && (
                    <div className="mode-subsettings" onClick={e => e.stopPropagation()}>
                      <label>Race Limit: {config.settings.racingNodesCount} Nodes</label>
                      <input 
                        type="range" 
                        min="2" 
                        max={Math.max(2, config.nodes.length)} 
                        value={config.settings.racingNodesCount} 
                        onChange={e => handleRacingNodesCountChange(e.target.value)} 
                      />
                    </div>
                  )}
                </div>
              </div>

              <div 
                className={`mode-option ${config.settings.mode === 'smart' ? 'active' : ''}`}
                onClick={() => handleModeChange('smart')}
              >
                <div className="mode-radio"></div>
                <div className="mode-details">
                  <h3>Smart Latency-Based Routing</h3>
                  <p>Routes all traffic through the single VPS node showing the lowest network latency. Best for consistent session tracking (like video calls or gaming).</p>
                </div>
              </div>

              <div 
                className={`mode-option ${config.settings.mode === 'static' ? 'active' : ''}`}
                onClick={() => handleModeChange('static')}
              >
                <div className="mode-radio"></div>
                <div className="mode-details">
                  <h3>Static Node Override</h3>
                  <p>Forces all proxy tunnels to go through a single node of your choice.</p>
                  {config.settings.mode === 'static' && (
                    <div className="mode-subsettings" onClick={e => e.stopPropagation()}>
                      <label>Select Node:</label>
                      <select 
                        value={config.settings.staticNodeId}
                        onChange={e => handleStaticNodeChange(e.target.value)}
                      >
                        {config.nodes.map(node => (
                          <option key={node.id} value={node.id}>
                            {node.flag} {node.name} ({node.host})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* NODES CARD */}
          <div className="glass-card nodes-card">
            <div className="card-header-with-actions">
              <h2>VPN NODES GATEWAY ({config.nodes.length})</h2>
              <button className="btn btn-primary" onClick={() => { setEditingNode(null); setShowAddModal(true); }}>
                + Add VPS Node
              </button>
            </div>

            <div className="nodes-list-container">
              {config.nodes.map(node => (
                <div key={node.id} className={`node-item ${node.enabled ? '' : 'disabled'}`}>
                  <div className="node-info">
                    <span className="node-flag">{node.flag}</span>
                    <div>
                      <div className="node-name-row">
                        <h4>{node.name}</h4>
                        <span className="node-country-tag">{node.country}</span>
                      </div>
                      <p className="node-details-text">{node.host}:{node.port}</p>
                    </div>
                  </div>

                  <div className="node-actions">
                    <span className={`node-latency ${node.latency > 0 ? (node.latency < 100 ? 'good' : node.latency < 250 ? 'warn' : 'poor') : 'offline'}`}>
                      {node.status === 'online' ? `${node.latency} ms` : node.status === 'offline' ? 'Offline' : 'Disabled'}
                    </span>
                    
                    <button className="btn-icon" title="Test Latency" onClick={(e) => handleTestNode(node.id, e)}>
                      ⏮
                    </button>
                    <button className="btn-icon" title="Edit Node" onClick={(e) => openEditModal(node, e)}>
                      ✎
                    </button>
                    <button className="btn-icon btn-delete" title="Delete Node" onClick={(e) => handleDeleteNode(node.id, e)}>
                      🗑
                    </button>
                    
                    <label className="switch">
                      <input 
                        type="checkbox" 
                        checked={node.enabled} 
                        onChange={(e) => handleNodeToggle(node.id, e.target.checked)}
                      />
                      <span className="slider round"></span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ROW 3: CONNECTION LOGS */}
        <section className="dashboard-row">
          <div className="glass-card logs-card">
            <h2>INTELLIGENT ROUTE LOGS</h2>
            <div className="table-responsive">
              <table className="logs-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Destination</th>
                    <th>Selected VPN Node</th>
                    <th>Routing Type</th>
                    <th>Connection Speed</th>
                    <th>Handshake Save</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="no-logs">Waiting for connection requests...</td>
                    </tr>
                  ) : (
                    logs.slice(0, 15).map(log => (
                      <tr key={log.id} className={log.status === 'active' ? 'log-active' : ''}>
                        <td>{new Date(log.timestamp).toLocaleTimeString()}</td>
                        <td className="log-dest">{log.host}:{log.port}</td>
                        <td>
                          <span className="log-node">
                            <span className="log-flag">{log.nodeFlag}</span>
                            {log.nodeName}
                          </span>
                        </td>
                        <td>
                          <span className={`badge-mode ${log.mode}`}>
                            {log.mode.toUpperCase()}
                          </span>
                        </td>
                        <td>{log.durationMs} ms</td>
                        <td className="log-save">
                          {log.savedMs > 0 ? (
                            <span className="save-highlight">⚡ Saved {log.savedMs}ms</span>
                          ) : '-'}
                        </td>
                        <td>
                          <span className={`status-dot ${log.status}`}></span>
                          {log.status === 'active' ? 'Active' : 'Closed'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

      </main>

      {/* ADD/EDIT NODE MODAL */}
      {showAddModal && (
        <div className="modal-backdrop">
          <div className="glass-card modal-content animate-slide-up">
            <h2>{editingNode ? 'Edit VPS Node' : 'Add VPS Node'}</h2>
            
            <form onSubmit={handleAddOrEditNode}>
              <div className="form-group">
                <label>Node Name</label>
                <input 
                  type="text" 
                  required 
                  placeholder="e.g. VPS Tokyo" 
                  value={formData.name} 
                  onChange={e => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div className="form-row">
                <div className="form-group flex-2">
                  <label>Host IP (WireGuard Internal IP)</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. 10.0.1.1" 
                    value={formData.host} 
                    onChange={e => setFormData({ ...formData, host: e.target.value })}
                  />
                </div>
                <div className="form-group flex-1">
                  <label>SOCKS5 Port</label>
                  <input 
                    type="number" 
                    required 
                    placeholder="1080" 
                    value={formData.port} 
                    onChange={e => setFormData({ ...formData, port: parseInt(e.target.value) })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-2">
                  <label>Country Name</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. Japan" 
                    value={formData.country} 
                    onChange={e => setFormData({ ...formData, country: e.target.value })}
                  />
                </div>
                <div className="form-group flex-1">
                  <label>Country Flag Emoji</label>
                  <input 
                    type="text" 
                    placeholder="e.g. 🇯🇵" 
                    value={formData.flag} 
                    onChange={e => setFormData({ ...formData, flag: e.target.value })}
                  />
                </div>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingNode ? 'Save Changes' : 'Create Node'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
