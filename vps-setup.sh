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
echo -e "\n${BLUE}Step 4: Creating local SOCKS5 proxy server...${NC}"
cat > /usr/local/bin/vps_socks5.py <<'EOF'
import socket
import select
import threading
import sys

def handle_client(client_socket):
    try:
        # SOCKS5 Handshake
        version, nmethods = client_socket.recv(2)
        if version != 5:
            client_socket.close()
            return
        methods = client_socket.recv(nmethods)
        # We accept NO AUTHENTICATION (0x00)
        client_socket.sendall(bytes([5, 0]))

        # Request
        version, cmd, _, atyp = client_socket.recv(4)
        if version != 5 or cmd != 1: # Only CONNECT supported (0x01)
            # Send connection not allowed
            client_socket.sendall(bytes([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
            client_socket.close()
            return

        if atyp == 1: # IPv4
            dest_ip = socket.inet_ntoa(client_socket.recv(4))
        elif atyp == 3: # Domain name
            domain_len = client_socket.recv(1)[0]
            dest_ip = client_socket.recv(domain_len).decode('utf-8')
        elif atyp == 4: # IPv6
            # We can support IPv6 or just return error
            client_socket.sendall(bytes([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
            client_socket.close()
            return
        else:
            client_socket.close()
            return

        dest_port = int.from_bytes(client_socket.recv(2), 'big')

        # Connect to destination
        dest_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        dest_socket.settimeout(10)
        try:
            dest_socket.connect((dest_ip, dest_port))
            # Get bound address details
            bind_ip, bind_port = dest_socket.getsockname()
            bind_ip_bytes = socket.inet_aton(bind_ip)
            bind_port_bytes = bind_port.to_bytes(2, 'big')
            # Success reply
            client_socket.sendall(bytes([5, 0, 0, 1]) + bind_ip_bytes + bind_port_bytes)
        except Exception as e:
            # Connection refused/general failure
            client_socket.sendall(bytes([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
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

    except Exception:
        try: client_socket.close()
        except Exception: pass

def main():
    if len(sys.argv) < 3:
        print("Usage: python vps_socks5.py <bind_ip> <bind_port>")
        sys.exit(1)
    bind_ip = sys.argv[1]
    bind_port = int(sys.argv[2])
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((bind_ip, bind_port))
    server.listen(256)
    print(f"SOCKS5 proxy listening on {bind_ip}:{bind_port}")
    while True:
        try:
            client, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(client,))
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
echo -e "WireGuard Status: $(systemctl is-active wg-quick@wg0)"
echo -e "SOCKS5 Proxy Status: $(systemctl is-active vpn-socks5)"
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
