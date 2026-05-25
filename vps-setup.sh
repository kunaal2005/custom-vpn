#!/bin/bash
# custom VPN VPS Node Setup Script
# Run this script as root on your Debian/Ubuntu VPS.

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Custom VPN VPS Node Setup ===${NC}"
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo bash vps-setup.sh)${NC}"
    exit 1
fi

# Detect public IP
PUBLIC_IP=$(curl -s https://ifconfig.me || curl -s https://api.ipify.org)
if [ -z "$PUBLIC_IP" ]; then
    read -p "Could not auto-detect public IP. Please enter VPS public IP: " PUBLIC_IP
fi
echo -e "Detected VPS Public IP: ${GREEN}$PUBLIC_IP${NC}"

# Inputs
read -p "Enter Node ID (e.g. 1 for node 1, 2 for node 2, etc. Max 254): " NODE_ID
NODE_ID=${NODE_ID:-1}
SUBNET_IP="10.0.${NODE_ID}.1"
CLIENT_IP="10.0.${NODE_ID}.2"

WG_PORT=$((51820 + NODE_ID))
read -p "Enter WireGuard Listen Port [default: $WG_PORT]: " WG_PORT_INPUT
WG_PORT=${WG_PORT_INPUT:-$WG_PORT}

SOCKS_PORT=1080
read -p "Enter SOCKS5 Proxy Port [default: $SOCKS_PORT]: " SOCKS_PORT_INPUT
SOCKS_PORT=${SOCKS_PORT_INPUT:-$SOCKS_PORT}

# Install dependencies
echo -e "\n${BLUE}Step 1: Installing WireGuard and Python...${NC}"
apt-get update
apt-get install -y wireguard iptables python3

# Detect active internet interface
DEFAULT_INTERFACE=$(ip route show | grep default | awk '{print $5}' | head -n 1)
DEFAULT_INTERFACE=${DEFAULT_INTERFACE:-eth0}
echo -e "Using network interface: ${GREEN}$DEFAULT_INTERFACE${NC}"

# Generate Keys
echo -e "\n${BLUE}Step 2: Generating WireGuard keys...${NC}"
mkdir -p /etc/wireguard
cd /etc/wireguard
umask 077

SERVER_PRIV=$(wg genkey)
SERVER_PUB=$(echo "$SERVER_PRIV" | wg pubkey)
CLIENT_PRIV=$(wg genkey)
CLIENT_PUB=$(echo "$CLIENT_PRIV" | wg pubkey)

# Configure WireGuard Server
echo -e "\n${BLUE}Step 3: Configuring WireGuard interface wg0...${NC}"
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $SERVER_PRIV
Address = $SUBNET_IP/24
ListenPort = $WG_PORT

# Routing and NAT for internet access through the VPN
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $DEFAULT_INTERFACE -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $DEFAULT_INTERFACE -j MASQUERADE

[Peer]
PublicKey = $CLIENT_PUB
AllowedIPs = $CLIENT_IP/32
EOF

# Install Python SOCKS5 Proxy Script
echo -e "\n${BLUE}Step 4: Creating local SOCKS5 proxy server with authentication...${NC}"

# Generate random credentials securely without hanging pipes
SOCKS_USER="vpn_user_$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 8)"
SOCKS_PASS="$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)"

# Save credentials in a secure env file restricted to root (chmod 600)
cat > /etc/vpn-socks5.env <<EOF
SOCKS_USER=$SOCKS_USER
SOCKS_PASS=$SOCKS_PASS
EOF
chmod 600 /etc/vpn-socks5.env

cat > /usr/local/bin/vps_socks5.py <<'EOF'
import socket
import select
import threading
import sys
import os

def log_message(msg):
    print(msg, flush=True)

def handle_client(client_socket, username, password, client_addr):
    try:
        log_message(f"Connection accepted from {client_addr[0]}:{client_addr[1]}")
        # SOCKS5 Handshake
        header = client_socket.recv(2)
        if len(header) < 2:
            client_socket.close()
            return
        version, nmethods = header[0], header[1]
        if version != 5:
            client_socket.close()
            return
        methods = client_socket.recv(nmethods)
        
        if username and password:
            if 2 not in methods:
                # Username/Password auth (0x02) required
                client_socket.sendall(bytes([5, 0xFF]))
                client_socket.close()
                return
            client_socket.sendall(bytes([5, 2]))
            
            # Subnegotiation auth
            auth_header = client_socket.recv(2)
            if len(auth_header) < 2:
                client_socket.close()
                return
            auth_version, ulen = auth_header[0], auth_header[1]
            if auth_version != 1:
                # Auth version must be 1
                client_socket.sendall(bytes([1, 1]))
                client_socket.close()
                return
            
            # Strict UTF-8 decoding to fail early on malformed credentials
            uname = client_socket.recv(ulen).decode('utf-8')
            plen_buf = client_socket.recv(1)
            if not plen_buf:
                client_socket.close()
                return
            plen = plen_buf[0]
            passwd = client_socket.recv(plen).decode('utf-8')
            
            if uname == username and passwd == password:
                client_socket.sendall(bytes([1, 0])) # Success
                log_message(f"Auth success for user: {uname}")
            else:
                client_socket.sendall(bytes([1, 1])) # Failure
                log_message(f"Auth failure for user: {uname}")
                client_socket.close()
                return
        else:
            # No auth allowed if username/password not configured
            if 0 not in methods:
                client_socket.sendall(bytes([5, 0xFF]))
                client_socket.close()
                return
            client_socket.sendall(bytes([5, 0]))

        # SOCKS5 Request
        req_header = client_socket.recv(4)
        if len(req_header) < 4:
            client_socket.close()
            return
        version, cmd, _, atyp = req_header[0], req_header[1], req_header[2], req_header[3]
        if version != 5 or cmd != 1: # Only CONNECT supported (0x01)
            client_socket.sendall(bytes([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
            client_socket.close()
            return

        if atyp == 1: # IPv4
            dest_ip = socket.inet_ntoa(client_socket.recv(4))
        elif atyp == 3: # Domain name
            len_buf = client_socket.recv(1)
            if not len_buf:
                client_socket.close()
                return
            domain_len = len_buf[0]
            dest_ip = client_socket.recv(domain_len).decode('utf-8')
        elif atyp == 4: # IPv6
            client_socket.sendall(bytes([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
            client_socket.close()
            return
        else:
            client_socket.close()
            return

        port_buf = client_socket.recv(2)
        if len(port_buf) < 2:
            client_socket.close()
            return
        dest_port = int.from_bytes(port_buf, 'big')

        # Connect to destination
        log_message(f"Routing traffic to {dest_ip}:{dest_port}")
        dest_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        dest_socket.settimeout(10)
        try:
            dest_socket.connect((dest_ip, dest_port))
            bind_ip, bind_port = dest_socket.getsockname()
            bind_ip_bytes = socket.inet_aton(bind_ip)
            bind_port_bytes = bind_port.to_bytes(2, 'big')
            client_socket.sendall(bytes([5, 0, 0, 1]) + bind_ip_bytes + bind_port_bytes)
        except Exception:
            client_socket.sendall(bytes([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
            log_message(f"Failed to connect to destination {dest_ip}:{dest_port}")
            client_socket.close()
            return

        # Forward data
        dest_socket.settimeout(None)
        client_socket.settimeout(None)
        
        def pipe(src, dst):
            try:
                while True:
                    data = src.recv(8192)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try: src.close()
                except Exception: pass
                try: dst.close()
                except Exception: pass

        t1 = threading.Thread(target=pipe, args=(client_socket, dest_socket))
        t2 = threading.Thread(target=pipe, args=(dest_socket, client_socket))
        t1.start()
        t2.start()

    except Exception as e:
        log_message(f"Error handling connection: {e}")
        try: client_socket.close()
        except Exception: pass

def main():
    if len(sys.argv) < 3:
        print("Usage: python vps_socks5.py <bind_ip> <bind_port>")
        sys.exit(1)
    bind_ip = sys.argv[1]
    bind_port = int(sys.argv[2])
    
    # Read credentials securely from environment variables populated by systemd EnvironmentFile
    username = os.environ.get('SOCKS_USER')
    password = os.environ.get('SOCKS_PASS')
    
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((bind_ip, bind_port))
    server.listen(256)
    if username and password:
        log_message(f"SOCKS5 proxy listening on {bind_ip}:{bind_port} with authentication enabled")
    else:
        log_message(f"SOCKS5 proxy listening on {bind_ip}:{bind_port} (no authentication)")
        
    while True:
        try:
            client, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(client, username, password, addr))
            t.daemon = True
            t.start()
        except KeyboardInterrupt:
            break
        except Exception:
            pass

if __name__ == '__main__':
    main()
EOF

chmod +x /usr/local/bin/vps_socks5.py

# Create systemd service for SOCKS5 proxy
echo -e "\n${BLUE}Step 5: Setting up SOCKS5 systemd service...${NC}"
cat > /etc/systemd/system/vpn-socks5.service <<EOF
[Unit]
Description=VPN SOCKS5 Proxy Service
After=network.target wg-quick@wg0.service
Requires=wg-quick@wg0.service

[Service]
Type=simple
# Load credentials from root-restricted environment file
EnvironmentFile=/etc/vpn-socks5.env
# Bind to WireGuard internal IP so it is only accessible via the tunnel
ExecStart=/usr/bin/python3 /usr/local/bin/vps_socks5.py $SUBNET_IP $SOCKS_PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Start and Enable Services
echo -e "\n${BLUE}Step 6: Starting and enabling services...${NC}"
systemctl daemon-reload
systemctl enable wg-quick@wg0
systemctl start wg-quick@wg0
systemctl enable vpn-socks5
systemctl start vpn-socks5

echo -e "\n${GREEN}=== VPS Node Setup Complete ===${NC}"
echo -e "WireGuard Status: \$(systemctl is-active wg-quick@wg0)"
echo -e "SOCKS5 Proxy Status: \$(systemctl is-active vpn-socks5)"
echo -e "\n--------------------------------------------------"
echo -e "Save the config below as ${GREEN}vpn-node${NODE_ID}.conf${NC} on your laptop."
echo -e "You can import this config directly into the official WireGuard app."
echo -e "--------------------------------------------------"
echo -e "${YELLOW}"
cat <<EOF
[Interface]
PrivateKey = $CLIENT_PRIV
Address = $CLIENT_IP/24
DNS = 1.1.1.1

[Peer]
PublicKey = $SERVER_PUB
Endpoint = $PUBLIC_IP:$WG_PORT
AllowedIPs = $SUBNET_IP/32, 10.0.${NODE_ID}.0/24
PersistentKeepalive = 25
EOF
echo -e "${NC}--------------------------------------------------"
echo -e "SOCKS5 Proxy Credentials for Dashboard (saved securely in /etc/vpn-socks5.env):"
echo -e "Username: ${GREEN}$SOCKS_USER${NC}"
echo -e "Password: ${GREEN}$SOCKS_PASS${NC}"
echo -e "Port: ${GREEN}$SOCKS_PORT${NC}"
echo -e "--------------------------------------------------"


