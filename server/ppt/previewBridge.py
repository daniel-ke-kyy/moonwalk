"""Access the original preview, preserving staged annotations across requests."""
import base64
import contextlib
import importlib.util
import json
from pathlib import Path
import sys

skill, project = (Path(value).resolve() for value in sys.argv[1:3])
request = json.load(sys.stdin)
with contextlib.redirect_stdout(sys.stderr):
    spec = importlib.util.spec_from_file_location(
        "moonwalk_native_preview", skill / "scripts/svg_editor/server.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    app = module.create_app(str(project), idle_timeout=0, live=True)
    staged = project / '.worker-tmp' / 'preview-annotations.json'
    editable = request.get('editable', False)
    if editable and staged.exists():
        app.config['ANNOTATIONS'] = json.loads(staged.read_text(encoding='utf-8'))
    with app.test_client() as client:
        response = client.open(request["path"], method=request.get('method', 'GET'),
                               json=request.get('body'), base_url="http://127.0.0.1")
        if editable:
            temporary = staged.with_suffix('.tmp')
            temporary.write_text(json.dumps(app.config['ANNOTATIONS']), encoding='utf-8')
            temporary.replace(staged)
        output = {
            "status": response.status_code,
            "contentType": response.content_type,
            "body": base64.b64encode(response.get_data()).decode("ascii"),
        }
print(json.dumps(output))
