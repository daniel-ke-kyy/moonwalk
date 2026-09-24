"""Use native annotation parsing and lifecycle records, never a second format."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import time
from lxml import etree as ET

skill, project = (Path(value).resolve() for value in sys.argv[1:3])
request = json.load(sys.stdin)
sys.path.insert(0, str(skill / 'scripts'))
with contextlib.redirect_stdout(sys.stderr):
    spec = importlib.util.spec_from_file_location('native_annotations', skill / 'scripts/check_annotations.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    results, unreadable = module.scan_directory(project)
    if unreadable:
        raise ValueError('; '.join(unreadable))
    if request['action'] == 'scan':
        output = results
    elif request['action'] == 'clear':
        for item in request['items']:
            name = item['page']
            if Path(name).name != name or not name.endswith('.svg'):
                raise ValueError('Invalid slide')
            target = project / 'svg_output' / name
            tree = ET.parse(target)
            for element in tree.getroot().iter():
                if element.get('id') == item['elementId']:
                    if element.get('data-edit-annotation') not in (None, item['instruction']):
                        raise ValueError('Annotation changed')
                    element.attrib.pop('data-edit-target', None)
                    element.attrib.pop('data-edit-annotation', None)
            tree.write(target, encoding='UTF-8', xml_declaration=True)
        output = {'cleared': len(request['items'])}
    elif request['action'] == 'log':
        log = project / 'live_preview' / 'annotations.jsonl'
        log.parent.mkdir(exist_ok=True)
        # Replaying a recovered commit must not duplicate lifecycle entries.
        old = log.read_text(encoding='utf-8') if log.exists() else ''
        if not any(json.loads(line).get('revision_id') == request['revisionId'] for line in old.splitlines() if line):
            with log.open('a', encoding='utf-8') as stream:
                for item in request['items']:
                    stream.write(json.dumps({'ts': time.time(), 'action': 'annotation_applied',
                        'revision_id': request['revisionId'], 'file': item['page'],
                        'element_id': item['elementId'], 'original': item['instruction']}, ensure_ascii=False) + '\n')
        output = {'logged': True}
    else:
        raise ValueError('Unknown action')
print(json.dumps(output, ensure_ascii=False))
