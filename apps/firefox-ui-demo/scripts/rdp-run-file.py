#!/usr/bin/env python3
"""
JS 파일을 읽어서 Firefox RDP chrome JS 컨텍스트에서 실행
Usage: python3 rdp-run-file.py <js_file>
"""
import socket, json, sys, pathlib

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

def run_js_file(js_file):
    js_code = pathlib.Path(js_file).read_text()
    print(f"[JS File] {js_file} ({len(js_code)} chars)")

    s = socket.socket()
    s.settimeout(5)
    try:
        s.connect((HOST, PORT))
        rdp_recv(s)  # greeting

        rdp_send(s, {"to": "root", "type": "listProcesses"})
        procs = rdp_recv(s)
        parent = next((p for p in procs.get('processes', []) if p.get('isParent')), None)

        rdp_send(s, {"to": parent['actor'], "type": "getTarget"})
        tgt = rdp_recv(s)
        console_actor = tgt.get('process', {}).get('consoleActor')
        print(f"[Console] {console_actor}")

        rdp_send(s, {
            "to": console_actor,
            "type": "evaluateJSAsync",
            "text": js_code,
            "options": {}
        })

        for _ in range(8):
            result = rdp_recv(s, timeout=4)
            if not result: break
            t = result.get('type', '?')
            if t == 'frameUpdate': continue
            print(f"[{t}] {json.dumps(result, ensure_ascii=False)[:4000]}")
            if t == 'evaluationResult' or 'result' in result: break

    except Exception as e:
        import traceback; traceback.print_exc()
    finally:
        s.close()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 rdp-run-file.py <js_file>")
        sys.exit(1)
    run_js_file(sys.argv[1])
