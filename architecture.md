# ▲ Custom VPN Architecture Diagram

This diagram visualizes how traffic flows from your local applications, through the Handshake Racing SOCKS5 Gateway and concurrent WireGuard tunnels, to the remote VPS nodes and final web destinations.

## Architecture Diagram

![VPN Architecture Diagram](assets/vpn_architecture.png)

### Mermaid Flowchart Representation

```mermaid
graph TD
    classDef client fill:#1E293B,stroke:#38BDF8,stroke-width:2px,color:#F8FAFC;
    classDef gateway fill:#0F172A,stroke:#A855F7,stroke-width:2px,color:#F8FAFC;
    classDef tunnels fill:#0F172A,stroke:#F43F5E,stroke-dasharray: 5 5,stroke-width:2px,color:#F8FAFC;
    classDef vps fill:#1E293B,stroke:#10B981,stroke-width:2px,color:#F8FAFC;
    classDef internet fill:#0F172A,stroke:#64748B,stroke-width:2px,color:#F8FAFC;

    subgraph User_Laptop ["Local Laptop (Windows)"]
        Apps["Applications (Chrome, Slack, etc.)"]:::client
        
        subgraph Gateway_Daemon ["Local SOCKS5 Gateway (127.0.0.1:1080)"]
            Racing["Racing Engine (Parallel Connects)"]:::gateway
            Cache["Domain Cache (5-Min Sessions)"]:::gateway
            Monitor["Latency Monitor (TCP Pings)"]:::gateway
        end
        
        WG1["WG Interface 1 (10.0.1.2)"]:::tunnels
        WG2["WG Interface 2 (10.0.2.2)"]:::tunnels
        WG3["WG Interface 3 (10.0.3.2)"]:::tunnels
    end

    subgraph Cloud_Nodes ["VPS Cloud Servers (Ubuntu)"]
        subgraph VPS_Node1 ["Node 1: India (20.244.24.171)"]
            SOCKS_IN["SOCKS5 Server (10.0.1.1:1080)"]:::vps
        end
        
        subgraph VPS_Node2 ["Node 2: Japan (20.189.200.227)"]
            SOCKS_JP["SOCKS5 Server (10.0.2.1:1080)"]:::vps
        end
        
        subgraph VPS_Node3 ["Node 3: France (20.19.83.100)"]
            SOCKS_FR["SOCKS5 Server (10.0.3.1:1080)"]:::vps
        end
    end

    subgraph Internet_Targets ["Public Internet"]
        Dest1["Target Website A (Local)"]:::internet
        Dest2["Target Website B (Asian Host)"]:::internet
        Dest3["anime.nexus (European Host)"]:::internet
    end

    %% Client Connections
    Apps -->|SOCKS5 Request| Gateway_Daemon
    
    %% Internal Routing Tunnels
    Racing -.->|Tunnel 1| WG1
    Racing -.->|Tunnel 2| WG2
    Racing -.->|Tunnel 3| WG3
    
    %% Physical WireGuard Connections
    WG1 ===|WG Tunnel 1| SOCKS_IN
    WG2 ===|WG Tunnel 2| SOCKS_JP
    WG3 ===|WG Tunnel 3| SOCKS_FR
    
    %% Target Outbound routing
    SOCKS_IN -->|Fastest for A| Dest1
    SOCKS_JP -->|Fastest for B| Dest2
    SOCKS_FR -->|Fastest for anime.nexus| Dest3
```

---

## Component Explanations

1. **Applications**: Your browser or desktop tools make proxy requests to `127.0.0.1:1080`.
2. **Racing Engine**: Resolves target hosts and launches concurrent connection handshakes through India, Japan, and France.
3. **Domain Cache**: Records the winning optimal node for each host (e.g. caches France for `anime.nexus`) so that subsequent connection loads bypass the racing stage for 5 minutes.
4. **Latency Monitor**: Routinely tests pings to all active nodes so the proxy only races online, healthy tunnels.
5. **WireGuard Tunnels**: Private point-to-point tunnels (`10.0.X.2` to `10.0.X.1`) established concurrently via split-tunneling.
6. **VPS Cloud Servers**: Clean remote nodes running standard Python SOCKS5 proxies bound to their internal interfaces.
