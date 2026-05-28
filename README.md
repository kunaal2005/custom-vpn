# ▲ Custom Multi-Node VPN Client (v1.0)

An intelligent, multi-hop SOCKS5 routing gateway over WireGuard featuring **TCP Handshake Racing with SOCKS5 RTT Compensation** (Happy Eyeballs across multiple geographic nodes) and a premium glassmorphic dashboard.

---

## 🌟 Key Architecture & How It Works

### 1. SOCKS5 Routing Over WireGuard
Your applications and browser connect to `127.0.0.1:1080` (the local proxy daemon). When you request a connection, the local proxy contacts the VPS's internal IP (e.g., `10.0.3.1:1080`). Since `10.0.3.1` matches the subnet route of WireGuard Interface 3, your operating system automatically routes the connection through that specific encrypted tunnel. The VPS proxy then carries out the request on the public internet.

### 2. TCP Handshake Racing with SOCKS5 RTT Compensation
To bypass geoblocks and route traffic through the fastest node, the proxy initiates parallel connections to target domains through all online VPS nodes in parallel (up to your configured limit).

#### The SOCKS5 Handshake Penalty
In standard SOCKS5, the handshake process requires 4 round-trips (RTT) between the client and the VPS:
1. TCP Connect (1 RTT)
2. SOCKS5 Greeting & Negotiation (1 RTT)
3. Username/Password Authentication (1 RTT)
4. SOCKS5 CONNECT Request & Remote connection to target (1 RTT + VPS-to-Target connection time)

Because of this 4x overhead, a node with low local latency (e.g., India at 65ms) would *always* win the race against a node with higher local latency (e.g., France at 192ms), even if the France node connects to the target website (e.g., European servers) much faster!

#### Our Dynamic Route Optimization Solution
To make routing truly dynamic and optimal, our proxy engine implements **SOCKS5 RTT Compensation**:
1. **Immediate Response**: The very first socket to successfully complete the SOCKS5 handshake is immediately resolved and piped to the client application so there is no loading delay.
2. **Background Settle**: The remaining racing connections are allowed to complete in the background (within a 4-second timeout).
3. **RTT Calculation**: Once all connections settle, the daemon calculates the **Estimated Data RTT** for each node:
   $$\text{Estimated Data RTT} = \text{Total Handshake Duration} - 3 \times \text{Client-to-VPS Latency}$$
4. **Optimal Route Caching**: The node with the lowest Estimated RTT is cached for that domain. All subsequent connections to that domain (which happen instantly as a web page loads scripts, styles, images) are routed directly through that optimal node.
5. **Leak Prevention**: Sockets of non-winning connections are immediately destroyed to prevent socket and memory leaks.

---

## 📂 Project Structure

```
d:\PROGRAMING\vpn\
├── daemon/                     # Node.js backend daemon
│   ├── config.json             # Active node list & application settings (gitignored)
│   ├── config.example.json     # Configuration template (safe to share)
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
├── start.bat                   # Silent startup script (spawns hidden terminals)
└── stop.bat                    # Process termination cleanup script
```

---

## 🚀 Setup Instructions

### Phase 1: Deploy Your VPS Nodes
You can set up as many nodes as you want. For each VPS, perform the following steps:

1. Connect to your VPS via SSH as `root` (or as a user with `sudo` privileges).
2. Upload the contents of [vps-setup.sh](vps-setup.sh) to the VPS.
3. Run the script:
   ```bash
   sudo bash vps-setup.sh
   ```
4. Follow the interactive prompts:
   - **Node ID**: Input a unique number for each node (e.g. `1` for India, `2` for Japan, `3` for France). This allocates a distinct subnet (e.g., `10.0.1.0/24`, `10.0.2.0/24`, `10.0.3.0/24`) to prevent routing conflicts.
   - **Ports**: Press `Enter` to accept the default ports (WireGuard: `51820+ID`, SOCKS5: `1080`).
5. The setup script will install WireGuard and configure a python SOCKS5 authentication proxy, generating credentials automatically.
6. **CRITICAL**: The script will complete and print a block of client WireGuard configuration text. Save this block on your laptop as `vpn-nodeX.conf` (where `X` is the Node ID).

#### Cloud Security Rules (Azure/AWS)
For each node, ensure the following inbound ports are allowed in your network security group:
- **`22` (TCP)**: SSH Management Access.
- **`51820 + ID` (UDP)**: WireGuard Handshake port (e.g., `51821` for Node 1, `51823` for Node 3).

---

### Phase 2: Install WireGuard on Your Laptop
1. Download and install the official client from [Wireguard](https://www.wireguard.com/install/).
2. Open the WireGuard application.
3. Click **Add Tunnel** and select the `vpn-nodeX.conf` files you generated in Phase 1.
4. **Important**: Because each config has `AllowedIPs = 10.0.X.1/32, 10.0.X.0/24`, they only route VPN internal subnet traffic through the tunnel. General internet traffic is unaffected.
5. Turn **ON** all the imported tunnels. They will run concurrently in the background without conflicts!

---

### Phase 3: Configure SOCKS5 Daemon Settings
1. Navigate to the `daemon/` directory.
2. Copy `config.example.json` to `config.json`.
3. Edit `config.json` and insert the remote credentials and IP addresses generated during Phase 1:
   - `host`: The internal IP of the node (e.g., `10.0.3.1`).
   - `port`: The SOCKS5 port (default `1080`).
   - `username` / `password`: SOCKS5 credentials printed by the setup script.
   - `ip`: The public IP of the VPS (e.g., `20.19.83.100`).
   - `sshKeyPath`: Local path to your private key file `.pem` (used for service restarts).

---

### Phase 4: Launch the Dashboard & Gateway
1. Navigate to the root folder `d:\PROGRAMING\vpn\`.
2. Double-click [start.bat](start.bat).
3. The launcher will:
   - Launch the local SOCKS5 routing daemon silently in background mode.
   - Launch the Vite development server silently in background mode.
   - Open your default browser to the Control Panel at `http://localhost:5173`.
4. To shut down the SOCKS5 proxy and frontend servers, simply **press any key** in the main terminal window.
5. If you close the terminal window by clicking the `X` button, double-click **[stop.bat](stop.bat)** to cleanly terminate the background processes.

---

## 💻 Tray Network Icon Behavior (FAQ)

* **Why does the Windows tray icon show "Wi-Fi" rather than "Ethernet/VPN" when the VPN is active?**
  Commercial VPN clients install virtual TUN/TAP network adapters and route the entire OS default gateway (`0.0.0.0/0`) through the adapter. Windows detects this and changes the icon.
  In this custom VPN, the routing is split-tunnel. Traffic only goes through the WireGuard interface when it hits the local SOCKS5 proxy (`127.0.0.1:1080`). Since the raw OS networking still passes through your physical network interface, Windows displays the physical Wi-Fi connection icon. This split-tunneling is a **requirement** for TCP Handshake Racing across multiple concurrent interfaces to function.
