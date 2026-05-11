#!/usr/bin/env python3
"""Firefox RDP 연결 테스트 및 JS 주입"""
import socket, json, time, sys

HOST = '127.0.0.1'
PORT = 6000

def rdp_recv(s):
    """Firefox RDP 패킷 수신 (길이:JSON 형식)"""
    data = b''
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
        # RDP 프로토콜: "숫자:" 로 시작
        if b':' in data:
            colon = data.index(b':')
            length = int(data[:colon])
            if len(data) >= colon + 1 + length:
                return json.loads(data[colon+1:colon+1+length])
    return None

def rdp_send(s, msg):
    """Firefox RDP 패킷 전송"""
    payload = json.dumps(msg).encode()
    packet = f"{len(payload)}:".encode() + payload
    s.sendall(packet)

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(5)

try:
    s.connect((HOST, PORT))
    print(f"[OK] RDP 연결 성공: {HOST}:{PORT}")

    # 1. Greeting 수신
    greeting = rdp_recv(s)
    print(f"[Greeting] {json.dumps(greeting, indent=2)[:300]}")

    # 2. listTabs 요청
    rdp_send(s, {"to": "root", "type": "listTabs"})
    tabs = rdp_recv(s)
    print(f"[listTabs] 탭 수: {len(tabs.get('tabs', []))}")
    for t in tabs.get('tabs', []):
        print(f"  - {t.get('title', '?')} | actor: {t.get('actor', '?')}")

    # 3. chrome context 접근 (privileged)
    if 'chromeDebugger' in greeting:
        chrome_actor = greeting['chromeDebugger']
        print(f"[Chrome] chrome debugger actor: {chrome_actor}")

        # JS 실행
        rdp_send(s, {
            "to": chrome_actor,
            "type": "evaluateJSAsync",
            "text": "typeof spawnBrowserCard !== 'undefined' ? 'EGDesk OK' : 'EGDesk NOT FOUND'"
        })
        result = rdp_recv(s)
        print(f"[JS Result] {result}")

except ConnectionRefusedError:
    print(f"[FAIL] 포트 {PORT} 연결 거부 - Firefox RDP가 활성화되지 않았습니다")
except Exception as e:
    print(f"[ERROR] {e}")
finally:
    s.close()
