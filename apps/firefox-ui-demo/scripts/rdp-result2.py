#!/usr/bin/env python3
"""Run a JS file via RDP and save full output to /tmp/rdp_output.txt, then extract result."""
import subprocess, sys, json, re

if len(sys.argv) < 2:
    print("Usage: rdp-result2.py <js-file>")
    sys.exit(1)

js_file = sys.argv[1]
scripts_dir = "/Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo/scripts"
proc = subprocess.run(
    ["python3", f"{scripts_dir}/rdp-run-file.py", js_file],
    capture_output=True, text=True, timeout=15
)
output = proc.stdout + proc.stderr

# Save full output
with open("/tmp/rdp_output.txt", "w") as f:
    f.write(output)

# Find the "result" field value using a more robust approach
# The JSON may be cut off at the end, but "result" comes before "startTime"
m = re.search(r'"result":\s*"((?:[^"\\]|\\.)*)"', output)
if m:
    val = m.group(1)
    # Unescape JSON string escapes
    val = val.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\\\\', '\\')
    print(val)
elif '"result": null' in output or '"result":null' in output:
    print("(null result)")
else:
    # Check for exception
    if '"hasException": true' in output or '"hasException":true' in output:
        em = re.search(r'"exceptionMessage":\s*"((?:[^"\\]|\\.)*)"', output)
        if em:
            print("EXCEPTION:", em.group(1))
        else:
            print("EXCEPTION (no message)")
    else:
        print("Could not extract result. See /tmp/rdp_output.txt")
