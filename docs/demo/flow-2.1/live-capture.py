#!/usr/bin/env python3
"""Zero-cost live check that flow 2.1's capture works inside a real interactive Claude Code session.

It starts the real TUI in a pseudo-terminal with this repo's plugin (--plugin-dir), types two engineer prompts and
/exit. An extra UserPromptSubmit hook blocks each prompt after a short delay, so no model call is ever made
(cost $0), while flow's own hooks still run. Then it prints what flow captured: the queue/incidents, the session
record written by the async SessionEnd hook, and the clusters built by the background worker.

  python3 docs/demo/flow-2.1/live-capture.py [path/to/claude]
"""
import json, os, pty, re, select, shutil, subprocess, sys, tempfile, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
claude = sys.argv[1] if len(sys.argv) > 1 else shutil.which("claude") or "claude"
work = tempfile.mkdtemp(prefix="flow-live-")
home, repo = os.path.join(work, "home"), os.path.join(work, "repo")
os.makedirs(repo)
subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
blocker = os.path.join(work, "block.mjs")
open(blocker, "w").write('let s=""; for await (const c of process.stdin) s+=c; await new Promise(r=>setTimeout(r,3000)); process.stderr.write("blocked: no model call"); process.exit(2);\n')
settings = os.path.join(work, "settings.json")
json.dump({"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": f"node {blocker}"}]}]}}, open(settings, "w"))

env = dict(os.environ, FLOW_FEEDBACK_HOME=home, TERM="xterm-256color")
for key in ["CLAUDE_CODE_SESSION_ATTENDED", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET"]:
    env.pop(key, None)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo)
    os.execve(claude, [claude, "--model", "haiku", "--plugin-dir", os.path.join(ROOT, "plugins/flow"), "--setting-sources", "local", "--strict-mcp-config", "--settings", settings], env)

out = b""
def pump(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try: out += os.read(fd, 65536)
            except OSError: return

pump(7)
if b"trust" in out.lower():  # the workspace trust dialog defaults to "No, exit"
    os.write(fd, b"\x1b[B"); pump(0.5); os.write(fd, b"\r"); pump(5)
for prompt in ["please don't merge anything yet, I want to review it", "I explicitly said not to merge. Why did you merge the PR?"]:
    for ch in prompt:
        os.write(fd, ch.encode()); time.sleep(0.01)
    pump(1); os.write(fd, b"\r"); pump(6)
    os.write(fd, b"\x15"); pump(0.5)  # clear the blocked prompt the composer restores
os.write(fd, b"/exit"); pump(1); os.write(fd, b"\r"); pump(10)
try: os.kill(pid, 9)
except Exception: pass
time.sleep(3)

def lines(name):
    path = os.path.join(home, name)
    return [json.loads(l) for l in open(path)] if os.path.exists(path) else []
print("blocked before the model:", "blocked: no model call" in re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out.decode("utf8", "ignore")))
print("incidents:", json.dumps([{k: i.get(k) for k in ("category", "keys", "source", "model")} for i in lines("incidents.jsonl")]))
print("sessions:", json.dumps(lines("sessions.jsonl")))
clusters = json.load(open(os.path.join(home, "clusters.json"))) if os.path.exists(os.path.join(home, "clusters.json")) else []
print("clusters:", json.dumps([{k: c[k] for k in ("id", "occurrences", "actionable", "coverage")} for c in clusters]))
shutil.rmtree(work, ignore_errors=True)
