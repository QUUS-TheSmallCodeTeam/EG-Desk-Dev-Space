#!/usr/bin/env python3
"""Firefox RDP actor 구조 전체 탐색"""
import socket, json

HOST, PORT = '127.0.0.1', 6000

def rdp_recv(s, timeout=3):
    s.settimeout(timeout)
    data = b''
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk: break
            data += chunk
            if b':' in data:
                colon = data.index(b':')
                try:
                    length = int(data[:colon])
                    if len(data) >= colon + 1 + length:
                        return json.loads(data[colon+1:colon+1+length])
                except: pass
    except socket.timeout:
        if data:
            try:
                colon = data.index(b':')
                return json.loads(data[colon+1:colon+1+int(data[:colon])])
            except: pass
    return None

def rdp_send(s, msg):
    p = json.dumps(msg).encode()
    s.sendall(f"{len(p)}:".encode() + p)

s = socket.socket()
s.connect((HOST, PORT))

# Greeting
g = rdp_recv(s)
print("=== GREETING ===")
print(json.dumps(g, indent=2, ensure_ascii=False)[:1000])

# getRoot
rdp_send(s, {"to": "root", "type": "getRoot"})
root = rdp_recv(s)
print("\n=== ROOT ===")
print(json.dumps(root, indent=2, ensure_ascii=False)[:1000])

# listTabs
rdp_send(s, {"to": "root", "type": "listTabs"})
tabs = rdp_recv(s)
print("\n=== TABS ===")
for t in tabs.get('tabs', []):
    print(f"  title={t.get('title')} actor={t.get('actor')} console={t.get('consoleActor')}")

# listProcesses
rdp_send(s, {"to": "root", "type": "listProcesses"})
procs = rdp_recv(s)
print("\n=== PROCESSES ===")
for p in procs.get('processes', []):
    print(f"  isParent={p.get('isParent')} actor={p.get('actor')}")

# parent process getTarget
parent = next((p for p in procs.get('processes', []) if p.get('isParent')), None)
if parent:
    rdp_send(s, {"to": parent['actor'], "type": "getTarget"})
    tgt = rdp_recv(s)
    print("\n=== PARENT TARGET ===")
    print(json.dumps(tgt, indent=2, ensure_ascii=False)[:2000])

s.close()
