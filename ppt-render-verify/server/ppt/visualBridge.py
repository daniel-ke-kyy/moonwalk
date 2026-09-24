"""Short-lived, loopback-only transport for the unchanged native visual renderer."""
import contextlib
import importlib.util
import json
import secrets
import sys
import threading
from pathlib import Path

skill, project = (Path(value).resolve() for value in sys.argv[1:3])
port = int(sys.argv[3])
request = json.load(sys.stdin)
sys.path.insert(0, str(skill / "scripts"))
from visual_review import check_server, discover_pages, file_lock, render_pages, fetch_slide_content, parse_slide_canvas
from werkzeug.serving import make_server, WSGIRequestHandler

class QuietHandler(WSGIRequestHandler):
    def log(self, *args, **kwargs):
        pass

with contextlib.redirect_stdout(sys.stderr):
    spec = importlib.util.spec_from_file_location("moonwalk_visual_preview", skill / "scripts/svg_editor/server.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app = module.create_app(str(project), idle_timeout=0, live=True)
    prefix = "/" + secrets.token_urlsafe(32)

    def private_app(environ, start_response):
        route = environ.get("PATH_INFO", "")
        if environ.get("REQUEST_METHOD") != "GET" or not route.startswith(prefix + "/"):
            start_response("404 Not Found", [("Content-Type", "text/plain")])
            return [b"Not found"]
        environ["SCRIPT_NAME"] = prefix
        environ["PATH_INFO"] = route[len(prefix):]
        return app(environ, start_response)

    server = make_server("127.0.0.1", port, private_app, threaded=True, request_handler=QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{port}{prefix}"
        check_server(url, project)
        pages = discover_pages(project, request.get("pages"))
        if len(pages) > 100:
            raise ValueError("Visual review is limited to 100 pages")
        for page in pages:
            canvas = parse_slide_canvas(fetch_slide_content(url, page), page)
            if canvas["png_width"] > 4096 or canvas["png_height"] > 4096 or canvas["png_width"] * canvas["png_height"] > 8_000_000:
                raise ValueError("Slide exceeds the bounded raster canvas")
        preview = project / ".preview"
        with file_lock(preview / ".render.lock"):
            records = render_pages(url, pages, preview)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
print(json.dumps({"pages": records}))
