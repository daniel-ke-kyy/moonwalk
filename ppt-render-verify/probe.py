"""One-shot isolation capability test. No model keys or user files are read."""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer


def check(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10,
                                env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        return {"code": result.returncode, "stdout": result.stdout[:2000],
                "stderr": result.stderr[:2000]}
    except Exception as error:
        return {"error": str(error)}


results = {
    "user_namespace": check(["unshare", "--user", "--map-root-user", "true"]),
    "mount_namespace": check(["unshare", "--user", "--map-root-user", "--mount", "true"]),
    "network_namespace": check(["unshare", "--user", "--map-root-user", "--net", "true"]),
    "mount_isolation": check(["unshare", "--user", "--map-root-user", "--mount",
                              "sh", "-c", "mount --make-rslave /"]),
    "landlock_abi": check(["/usr/local/bin/python", "-c",
        "import ctypes,os; c=ctypes.CDLL(None,use_errno=True); r=c.syscall(444,0,0,1); print({'abi':r,'errno':ctypes.get_errno()})"]),
    "isolated_worker": check([
        "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
        "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "/bin/sh", "-c", "test ! -e /probe/probe.py && echo isolated-worker-ready"
    ]),
}
print(json.dumps(results), flush=True)

root = Path(tempfile.mkdtemp(prefix="ppt-probe-"))
root.chmod(0o755)
(root / "secret").write_text("probe-only-secret")
(root / "secret").chmod(0o600)
work = root / "project"
work.mkdir(mode=0o1770)
work.chmod(0o1770)
os.chown(work, 0, 65534)
out = work / "output"
out.mkdir(mode=0o700)
os.chown(out, 65534, 65534)
policy = json.dumps({"read": ["/usr", "/lib", "/lib64", "/proc", str(work), "/dev/urandom"],
                     "write": [str(work), "/dev/null"], "port": 0})
try:
    result = subprocess.run(["/usr/local/bin/ppt-sandbox", policy, "/usr/local/bin/python", "-c",
        "import pathlib,socket; p=pathlib.Path('output/pass'); p.write_text('ok'); "
        "assert p.read_text()=='ok'; "
        "print('worker-started', flush=True); "
        f"pathlib.Path({str(root / 'secret')!r}).read_text()"],
        cwd=work, user=65534, group=65534, extra_groups=[], capture_output=True,
        text=True, timeout=20, env={"PATH":"/usr/local/bin:/usr/bin:/bin", "HOME":str(out), "TMPDIR":str(out)})
    results["landlock_worker"] = {"code":result.returncode, "stdout":result.stdout[-2000:], "stderr":result.stderr[-2000:]}
except Exception as error:
    results["landlock_worker"] = {"error":str(error)}
print(json.dumps(results), flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/health", "/capabilities"):
            self.send_error(404)
            return
        body = json.dumps({"ok": True} if self.path == "/health" else results).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "10000"))), Handler).serve_forever()
