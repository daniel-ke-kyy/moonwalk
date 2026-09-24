"""Read-only adapter to the upstream notes parser; splitting remains an export step."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
from total_md_split import find_svg_files, parse_total_md, check_svg_note_mapping

project = Path(sys.argv[2])
pages = find_svg_files(project)
notes = parse_total_md(project / "notes" / "total.md", [p.stem for p in pages], False)
matched, missing = check_svg_note_mapping(pages, notes)
empty = [p.stem for p in pages if not notes.get(p.stem, "").strip()]
print(json.dumps({"matched": matched and bool(pages), "missing": missing, "empty": empty}))
sys.exit(0 if matched and pages and not empty else 1)
