#!/usr/bin/env python3
"""Run a JS file via RDP and print only the result value."""
import subprocess, sys, json, re

if len(sys.argv) < 2:
    print("Usage: rdp-result.py <js-file>")
    sys.exit(1)

js_file = sys.argv[1]
scripts_dir = "/Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/scripts"
proc = subprocess.run(
    ["python3", f"{scripts_dir}/rdp-run-file.py", js_file],
    capture_output=True, text=True, timeout=15
)
output = proc.stdout + proc.stderr

# The output may be truncated in display but the full JSON is there
# Find evaluationResult JSON - it may span multiple lines
lines = output.split('\n')
eval_line = ''
for i, line in enumerate(lines):
    if '[evaluationResult]' in line:
        # Collect from here to end
        eval_line = line.replace('[evaluationResult] ', '')
        # May need to join subsequent lines
        for j in range(i+1, len(lines)):
            if lines[j].startswith('[') or lines[j].startswith('~/'):
                break
            eval_line += lines[j]
        break

if eval_line:
    try:
        data = json.loads(eval_line)
        if data.get("hasException"):
            print("EXCEPTION:", data.get("exceptionMessage", data.get("result", "")))
        else:
            print(data.get("result", "(no result)"))
    except json.JSONDecodeError as e:
        # Try regex extraction
        m = re.search(r'"result":\s*"((?:[^"\\]|\\.)*)"', eval_line)
        if m:
            val = m.group(1).encode().decode('unicode_escape')
            print(val)
        else:
            print(f"JSON PARSE ERROR: {e}")
            print(f"Raw (first 300): {eval_line[:300]}")
else:
    print("NO evaluationResult found in output")
    print(output[:500])
