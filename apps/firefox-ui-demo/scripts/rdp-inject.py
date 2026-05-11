#!/usr/bin/env python3
"""
Firefox RDP를 통해 chrome JS 컨텍스트(browser.xhtml)에서 EGDesk 함수 호출
Usage: python3 rdp-inject.py "JS 코드"
"""
import socket, json, sys

HOST, PORT = '127.0.0.1', 6000

def rdp_recv(s, timeout=5):
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

def eval_js(js_code):
    s = socket.socket()
    s.settimeout(5)
    try:
        s.connect((HOST, PORT))
        rdp_recv(s)  # greeting

        # listProcesses → parent
        rdp_send(s, {"to": "root", "type": "listProcesses"})
        procs = rdp_recv(s)
        parent = next((p for p in procs.get('processes', []) if p.get('isParent')), None)
        if not parent:
            print("[ERROR] parent process 없음")
            return

        # getTarget → consoleActor
        rdp_send(s, {"to": parent['actor'], "type": "getTarget"})
        tgt = rdp_recv(s)
        console_actor = tgt.get('process', {}).get('consoleActor')
        if not console_actor:
            print("[ERROR] consoleActor 없음")
            print(json.dumps(tgt)[:300])
            return

        print(f"[Console] {console_actor}")
        print(f"[URL] {tgt.get('process', {}).get('url')}")

        # evaluateJSAsync
        rdp_send(s, {
            "to": console_actor,
            "type": "evaluateJSAsync",
            "text": js_code,
            "options": {}
        })

        # 결과 수신 (여러 패킷)
        for _ in range(8):
            result = rdp_recv(s, timeout=4)
            if not result:
                break
            t = result.get('type', '?')
            print(f"[{t}] {json.dumps(result, ensure_ascii=False)[:500]}")
            if t in ('evaluationResult', 'result') or 'result' in result:
                break

    except ConnectionRefusedError:
        print(f"[FAIL] 포트 {PORT} 연결 거부 — Firefox가 --start-debugger-server 6000 으로 실행됐는지 확인")
    except Exception as e:
        import traceback; traceback.print_exc()
    finally:
        s.close()

if __name__ == '__main__':
    js = sys.argv[1] if len(sys.argv) > 1 else "typeof spawnBrowserCard"
    print(f"[JS] {js}")
    eval_js(js)
