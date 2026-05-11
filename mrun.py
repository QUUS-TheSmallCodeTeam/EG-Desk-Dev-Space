#!/usr/bin/env python3
"""Execute JS in Firefox chrome context via Marionette. Keeps session alive."""
import socket, json, sys, pathlib

HOST, PORT = '127.0.0.1', 2828

def recv_pkt(s, timeout=10):
    s.settimeout(timeout)
    data = b''
    try:
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
            if b':' in data:
                colon = data.index(b':')
                try:
                    length = int(data[:colon])
                    if len(data) >= colon + 1 + length:
                        return json.loads(data[colon+1:colon+1+length])
                except ValueError:
                    pass
    except socket.timeout:
        if data:
            try:
                colon = data.index(b':')
                return json.loads(data[colon+1:colon+1+int(data[:colon])])
            except:
                pass
    return None

def send_cmd(s, cmd_id, method, params=None):
    msg = [0, cmd_id, method, params or {}]
    p = json.dumps(msg).encode()
    s.sendall(f"{len(p)}:".encode() + p)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 mrun.py <js_file_or_code>")
        sys.exit(1)
    
    arg = sys.argv[1]
    try:
        js_code = pathlib.Path(arg).read_text()
        print(f"[File] {arg} ({len(js_code)} chars)")
    except:
        js_code = arg
    
    s = socket.socket()
    s.settimeout(10)
    s.connect((HOST, PORT))
    
    # Greeting
    recv_pkt(s)
    
    cid = 1
    # New session
    send_cmd(s, cid, "WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": True}}})
    recv_pkt(s, timeout=15)
    cid += 1
    
    # Chrome context
    send_cmd(s, cid, "Marionette:SetContext", {"value": "chrome"})
    recv_pkt(s)
    cid += 1
    
    # Execute
    send_cmd(s, cid, "WebDriver:ExecuteScript", {"script": js_code, "args": []})
    result = recv_pkt(s, timeout=30)
    if result:
        if result[0] == 1:
            if result[2]:
                err = result[2]
                print(f"[ERROR] {err.get('error','?')}: {err.get('message','')[:2000]}")
            else:
                val = result[3]
                if isinstance(val, dict) and 'value' in val:
                    out = val['value']
                else:
                    out = val
                if isinstance(out, str):
                    print(out)
                else:
                    print(json.dumps(out, ensure_ascii=False, indent=2)[:4000])
        else:
            print(json.dumps(result, ensure_ascii=False)[:4000])
    else:
        print("[No result]")
    
    cid += 1
    send_cmd(s, cid, "WebDriver:DeleteSession", {})
    try:
        recv_pkt(s, timeout=2)
    except:
        pass
    s.close()

if __name__ == '__main__':
    main()
