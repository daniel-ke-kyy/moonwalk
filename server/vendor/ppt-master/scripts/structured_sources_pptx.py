#!/usr/bin/env python3
"""Build a single editable PPTX source deck from role-specific one-slide PPTX files.

The template-fill engine expects all selectable source slides to live in one
PPTX package. Moonwalk lets users upload cover/agenda/section/content/ending
masters separately, so this helper imports the selected slide from each source
PPTX into one combined deck while preserving editable shapes and related media.
"""

from __future__ import annotations

import json
import posixpath
import re
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))

from template_fill_pptx.ooxml import (  # noqa: E402
    CT_NS,
    NS,
    REL_NS,
    SLIDE_CONTENT_TYPE,
    SLIDE_REL_TYPE,
    _normalize_part,
    _parse_slide_refs,
    _qn,
    _rels_name_for_part,
    _xml_bytes,
)
from template_fill_pptx.package import (  # noqa: E402
    _add_content_type_override,
    _add_slide_override,
    _content_type_root,
    _empty_relationships_root,
    _max_numeric_rid,
    _max_slide_id,
    _max_slide_part_number,
    _prune_unreferenced_parts,
    _relative_target,
)


@dataclass
class SourceDeck:
    source_id: str
    entries: dict[str, bytes]
    content_root: ET.Element
    defaults: dict[str, str]
    overrides: dict[str, str]
    slide_refs: dict[int, Any]


def _load_source(source: dict[str, Any]) -> SourceDeck:
    pptx_path = Path(source["pptx"]).expanduser().resolve()
    with zipfile.ZipFile(pptx_path) as zf:
        entries = {info.filename: zf.read(info.filename) for info in zf.infolist() if not info.is_dir()}
        content_root = _content_type_root(ET.fromstring(entries["[Content_Types].xml"]))
        slide_refs = {slide.index: slide for slide in _parse_slide_refs(zf)}

    defaults: dict[str, str] = {}
    for node in content_root.findall(_qn(CT_NS, "Default")):
        extension = node.attrib.get("Extension")
        content_type = node.attrib.get("ContentType")
        if extension and content_type:
            defaults[extension] = content_type

    overrides: dict[str, str] = {}
    for node in content_root.findall(_qn(CT_NS, "Override")):
        part_name = (node.attrib.get("PartName") or "").lstrip("/")
        content_type = node.attrib.get("ContentType")
        if part_name and content_type:
            overrides[part_name] = content_type

    return SourceDeck(
        source_id=str(source.get("id") or pptx_path.stem),
        entries=entries,
        content_root=content_root,
        defaults=defaults,
        overrides=overrides,
        slide_refs=slide_refs,
    )


def _ensure_default(content_root: ET.Element, extension: str, content_type: str) -> None:
    for node in content_root.findall(_qn(CT_NS, "Default")):
        if node.attrib.get("Extension") == extension:
            return
    ET.SubElement(
        content_root,
        _qn(CT_NS, "Default"),
        {"Extension": extension, "ContentType": content_type},
    )


def _content_type_for_part(source: SourceDeck, part: str) -> tuple[str, str] | None:
    override = source.overrides.get(part)
    if override:
        return ("override", override)
    extension = posixpath.splitext(part)[1].lstrip(".")
    default = source.defaults.get(extension)
    if default:
        return ("default", default)
    return None


def _copy_content_type(source: SourceDeck, target_content_root: ET.Element, source_part: str, target_part: str) -> None:
    content_type = _content_type_for_part(source, source_part)
    if not content_type:
        return
    kind, value = content_type
    if kind == "override":
        _add_content_type_override(target_content_root, target_part, value)
    else:
        extension = posixpath.splitext(target_part)[1].lstrip(".")
        if extension:
            _ensure_default(target_content_root, extension, value)


def _make_allocator(entries: dict[str, bytes], source_id: str):
    used = set(entries)
    safe_id = re.sub(r"[^A-Za-z0-9]+", "", source_id) or "src"

    def allocate(source_part: str) -> str:
        directory = posixpath.dirname(source_part)
        stem, ext = posixpath.splitext(posixpath.basename(source_part))
        index = 1
        while True:
            candidate = posixpath.join(directory, f"{stem}_mw{safe_id}_{index}{ext}")
            if candidate not in used:
                used.add(candidate)
                return candidate
            index += 1

    return allocate


def _copy_dependency(
    source: SourceDeck,
    source_part: str,
    *,
    target_entries: dict[str, bytes],
    target_content_root: ET.Element,
    allocate,
    copied: dict[str, str],
) -> str:
    if source_part in copied:
        return copied[source_part]
    if source_part not in source.entries:
        return source_part

    target_part = allocate(source_part)
    copied[source_part] = target_part
    target_entries[target_part] = source.entries[source_part]
    _copy_content_type(source, target_content_root, source_part, target_part)

    source_rels = _rels_name_for_part(source_part)
    if source_rels in source.entries:
        rels_root = ET.fromstring(source.entries[source_rels])
        _rewrite_relationships(
            source,
            rels_root,
            source_owner=source_part,
            target_owner=target_part,
            target_entries=target_entries,
            target_content_root=target_content_root,
            allocate=allocate,
            copied=copied,
        )
        target_entries[_rels_name_for_part(target_part)] = _xml_bytes(rels_root)

    return target_part


def _rewrite_relationships(
    source: SourceDeck,
    rels_root: ET.Element,
    *,
    source_owner: str,
    target_owner: str,
    target_entries: dict[str, bytes],
    target_content_root: ET.Element,
    allocate,
    copied: dict[str, str],
) -> None:
    for rel in rels_root.findall(_qn(REL_NS, "Relationship")):
        if rel.attrib.get("TargetMode") == "External":
            continue
        target = rel.attrib.get("Target")
        if not target:
            continue
        source_part = _normalize_part(target, source_owner)
        if source_part not in source.entries:
            continue
        copied_part = _copy_dependency(
            source,
            source_part,
            target_entries=target_entries,
            target_content_root=target_content_root,
            allocate=allocate,
            copied=copied,
        )
        rel.set("Target", _relative_target(target_owner, copied_part))


def build_structured_source_deck(manifest: dict[str, Any], output_path: Path) -> None:
    sources_config = manifest.get("sources")
    if not isinstance(sources_config, list) or not sources_config:
        raise RuntimeError("Manifest must contain a non-empty sources list")

    sources = [_load_source(item) for item in sources_config]
    base = sources[0]
    target_entries = dict(base.entries)
    target_content_root = _content_type_root(ET.fromstring(target_entries["[Content_Types].xml"]))
    pres_root = ET.fromstring(target_entries["ppt/presentation.xml"])
    pres_rels_root = ET.fromstring(target_entries["ppt/_rels/presentation.xml.rels"])
    sld_id_lst = pres_root.find("p:sldIdLst", NS)
    if sld_id_lst is None:
        sld_id_lst = ET.SubElement(pres_root, _qn(NS["p"], "sldIdLst"))

    for child in list(sld_id_lst):
        sld_id_lst.remove(child)
    for rel in list(pres_rels_root.findall(_qn(REL_NS, "Relationship"))):
        if rel.attrib.get("Type") == SLIDE_REL_TYPE:
            pres_rels_root.remove(rel)

    for source in sources:
        for extension, content_type in source.defaults.items():
            _ensure_default(target_content_root, extension, content_type)

    next_slide_number = _max_slide_part_number(target_entries) + 1
    next_slide_id = _max_slide_id(sld_id_lst) + 1
    next_rel_number = _max_numeric_rid(pres_rels_root) + 1

    for offset, source_item in enumerate(sources_config):
        source = sources[offset]
        slide_index = int(source_item.get("slide") or 1)
        source_ref = source.slide_refs.get(slide_index)
        if source_ref is None:
            raise RuntimeError(f"Source {source.source_id} does not contain slide {slide_index}")

        new_slide_number = next_slide_number + offset
        new_part = f"ppt/slides/slide{new_slide_number}.xml"
        new_rels = f"ppt/slides/_rels/slide{new_slide_number}.xml.rels"
        new_rid = f"rId{next_rel_number + offset}"
        target_entries[new_part] = source.entries[source_ref.part_name]
        _add_slide_override(target_content_root, new_part)

        source_rels = source.entries.get(source_ref.rels_name)
        rels_root = ET.fromstring(source_rels) if source_rels else _empty_relationships_root()
        allocate = _make_allocator(target_entries, source.source_id)
        _rewrite_relationships(
            source,
            rels_root,
            source_owner=source_ref.part_name,
            target_owner=new_part,
            target_entries=target_entries,
            target_content_root=target_content_root,
            allocate=allocate,
            copied={},
        )
        target_entries[new_rels] = _xml_bytes(rels_root)

        ET.SubElement(
            pres_rels_root,
            _qn(REL_NS, "Relationship"),
            {
                "Id": new_rid,
                "Type": SLIDE_REL_TYPE,
                "Target": f"slides/slide{new_slide_number}.xml",
            },
        )
        ET.SubElement(
            sld_id_lst,
            _qn(NS["p"], "sldId"),
            {"id": str(next_slide_id + offset), _qn(NS["r"], "id"): new_rid},
        )

    target_entries["ppt/presentation.xml"] = _xml_bytes(pres_root)
    target_entries["ppt/_rels/presentation.xml.rels"] = _xml_bytes(pres_rels_root)
    _prune_unreferenced_parts(target_entries, target_content_root)
    target_entries["[Content_Types].xml"] = _xml_bytes(target_content_root)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as out:
        for name, data in target_entries.items():
            out.writestr(name, data)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("Usage: structured_sources_pptx.py <manifest.json> <output.pptx>", file=sys.stderr)
        return 2
    manifest_path = Path(argv[1]).expanduser().resolve()
    output_path = Path(argv[2]).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    build_structured_source_deck(manifest, output_path)
    print(f"Structured source PPTX -> {output_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
