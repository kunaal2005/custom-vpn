# ▲ Custom Multi-Node VPN Client

An intelligent, multi-hop SOCKS5 routing gateway over WireGuard with **TCP Handshake Racing** (Happy Eyeballs across multiple geographic nodes) and a premium glassmorphic dashboard.

---

## 🌟 Features

- **Concurrent WireGuard Tunnels**: Maintain active connections to multiple VPS nodes simultaneously without routing conflicts by isolating node subnets.
- **TCP Handshake Racing**: Initiates parallel connections to target domains through all online nodes concurrently. Whichever node completes the 3-way handshake first wins the connection. This guarantees the lowest possible latency and bypasses geoblocking instantly.
- **Latency Monitor**: Periodically measures round-trip time (RTT) to all nodes via lightweight TCP pings.
- **Route-Caching**: Caches domain-to-node routing associations for 5 minutes, preventing session instability and login warnings on websites.
- **Windows System Proxy Integration**: Toggle system-wide routing directly from the control panel.
- **Live Bandwidth & Connection Logs**: View live speedometers, scrolling sparkline graphs, and logs of active and closed connections detailing which node was selected and the latency savings.

---

## 📂 Project Structure

```
d:\PROGRAMING\vpn\
├── daemon/                     # Node.js backend daemon
│   ├── config.json             # Active node list & application settings
│   ├── config-manager.js       # JSON settings manager
│   ├── monitor.js              # Node latency checker
│   ├── proxy.js                # Custom SOCKS5 server & Racing engine
│   ├── server.js               # REST & WebSocket API, Windows registry hook
│   └── package.json            # Backend dependencies
├── frontend/                   # Vite + React Dashboard UI
│   ├── src/
│   │   ├── App.jsx             # Glassmorphic React Dashboard component
│   │   ├── App.css             # Neon CSS styling & animations
│   │   └── main.jsx
│   └── index.html
├── vps-setup.sh                # Remote server setup script (Debian/Ubuntu)
└── start.bat                   # Desktop launch script
```

---

## 🚀 Setup Instructions

### Phase 1: Configure Your VPS Nodes
You can set up as many nodes as you want. For each VPS, perform the following steps:

1. Connect to your VPS via SSH as `root`.
2. Upload or paste the contents of [vps-setup.sh](file:///d:/PROGRAMING/vpn/vps-setup.sh) to the VPS.
3. Run the script:
   ```bash
   sudo bash vps-setup.sh
   ```
4. Follow the interactive prompts:
   - **Node ID**: Input a unique number for each node (e.g. `1` for Node 1, `2` for Node 2, `3` for Node 3). This allocates a distinct subnet (e.g., `10.0.1.0/24`, `10.0.2.0/24`) so tunnels do not conflict.
   - **Ports**: Press `Enter` to accept the default ports (WireGuard: `51821+ID`, SOCKS5: `1080`).
5. **CRITICAL**: The script will complete and print a block of client WireGuard configuration text. Save this block on your laptop as `vpn-nodeX.conf` (where `X` is the Node ID).

---

### Phase 2: Install WireGuard on Your Laptop
1. Download and install the official client from [Wireguard for Windows](https://www.wireguard.com/install/).
2. Open the WireGuard application.
3. Click **Add Tunnel** and select the `vpn-nodeX.conf` files you generated in Phase 1.
4. **Important**: Because each config has `AllowedIPs = 10.0.X.1/32, 10.0.X.0/24`, they only route VPN internal subnet traffic through the tunnel. General internet traffic is unaffected.
5. Turn **ON** all the imported tunnels. They will run concurrently in the background without conflicts!

---

### Phase 3: Launch the Dashboard & Gateway
1. Navigate to the project folder `d:\PROGRAMING\vpn\`.
2. Double-click [start.bat](file:///d:/PROGRAMING/vpn/start.bat).
3. The launcher will:
   - Install any missing node dependencies.
   - Boot up the local routing daemon.
   - Launch the Vite development server.
   - Open your default browser to `http://localhost:5173`.
4. In the Control Panel, you will see your active nodes, latency values, and a live connection log.

---

## ⚙️ How it Works

### 1. SOCKS5 Routing Over WireGuard
Your browser/applications connect to `127.0.0.1:1080` (the local proxy). When you request a connection, the local proxy contacts the VPS's internal IP (e.g. `10.0.2.1:1080`). Since `10.0.2.1` matches the subnet route of WireGuard Interface 2, the Windows OS automatically routes the connection through that specific encrypted tunnel. The VPS proxy then carries out the request on the public internet.

### 2. TCP Handshake Racing
When **Racing Mode** is active and you visit a website (e.g., `github.com`):
1. The local proxy initiates a SOCKS5 connect request to `github.com` through *multiple* VPS nodes in parallel (up to your configured limit).
2. The fastest node to complete the TCP handshake with GitHub wins.
3. The local proxy immediately pipes your browser data through this winning node, and destroys the sockets on the slower nodes.
4. The winning node is cached for `github.com` for 5 minutes to keep your session stable.

---

## 💻 System-wide Routing

To route all traffic from your laptop through the VPN, toggle the **System VPN State** switch in the dashboard.
- **Enabled**: Updates the Windows Internet Options registry to route all HTTP/HTTPS/SOCKS traffic through `127.0.0.1:1080`. Most desktop applications (Chrome, Firefox, Spotify, Slack, Discord) will respect this immediately.
- **Disabled**: Restores standard Windows network routing. You can still manually configure specific apps (like proxy extensions) to point to SOCKS5 `127.0.0.1:1080`.
