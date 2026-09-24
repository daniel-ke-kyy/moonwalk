"""Mount the unmodified native spec editor with durable per-project drafts."""
import base64
import json
import sys
from pathlib import Path

root, project = map(Path, sys.argv[1:3])
sys.path.insert(0, str(root / 'scripts'))
from spec_review.server import create_app
from spec_review.store import atomic_write
from project_management.project_specs import SCHEMA_DIR, validate_markdown_text, parse_markdown_artifact
from project_management.spec_blocks import split_spec_blocks
from markdown_it import MarkdownIt


def tables(body):
    rows, row = [], None
    for token in MarkdownIt().enable('table').parse(body):
        if token.type == 'tr_open':
            row = []
        elif token.type == 'inline' and row is not None:
            row.append(token.content)
        elif token.type == 'tr_close':
            rows.append(row)
            row = None
    return rows


def section_fields(section):
    # Native specs use both bullet fields and Markdown tables.
    values = {row[0]: row[1] for row in tables(section['body']) if len(row) == 2}
    return {**values, **section['fields']}

payload = json.load(sys.stdin)
app = create_app(str(project))
store = app.extensions['review_store']
state = project / 'spec_review' / 'website-drafts.json'
if state.exists():
    store.drafts = json.loads(state.read_text())
store.hold = payload.get('hold', True)
action = payload.get('action', 'request')
if action == 'inspect':
    document = store.document()
    sidecar = project / 'spec_review' / 'annotations.json'
    meta = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    log = project / 'spec_review' / 'edits.jsonl'
    unread = log.exists() and log.stat().st_size > meta.get('edits_cursor', 0)
    blocks = split_spec_blocks(document['text']).blocks
    print(json.dumps({**document, 'drafts': list(store.drafts),
        'annotations': store.annotations(), 'unreadEdits': bool(unread),
        'errors': validate_markdown_text(document['text'], SCHEMA_DIR / 'design_spec.schema.json', markdown_path=store.path),
        'fields': {s['heading']: section_fields(s) for s in parse_markdown_artifact(store.path)},
        'imageRows': [row for s in parse_markdown_artifact(store.path)
                      if s['heading'].startswith('VIII.') for row in tables(s['body'])
                      if row and row[0].lower() != 'filename'],
        'blocks': [{'key': b.key, 'title': b.title, 'kind': b.kind,
                    'text': document['text'][b.start:b.end]} for b in blocks]}, ensure_ascii=False))
elif action == 'todo':
    print(json.dumps(store.list_todo(), ensure_ascii=False))
elif action == 'applied':
    store.remove_annotation(payload['id'], applied=True)
    print('{"ok":true}')
elif action == 'ack':
    print(json.dumps({'cursor': store.ack_edits()}))
else:
    with app.test_client() as client:
        response = client.open(payload['path'], method=payload.get('method', 'GET'),
            json=payload.get('body'), base_url='http://localhost')
    state.parent.mkdir(exist_ok=True)
    atomic_write(state, json.dumps(store.drafts, ensure_ascii=False).encode())
    print(json.dumps({'status': response.status_code, 'contentType': response.content_type,
        'body': base64.b64encode(response.data).decode()}))
