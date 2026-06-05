"""Add simple editable shapes to cloned slides.

The template-fill path must keep uploaded PPTX masters editable. These helpers
append basic native PowerPoint shapes instead of flattening a master slide into a
background image.
"""

from __future__ import annotations

from typing import Any
from xml.etree import ElementTree as ET

from .ooxml import EMU_PER_INCH, NS, _qn

DEFAULT_CANVAS = {
    "width": int(13.333333 * EMU_PER_INCH),
    "height": int(7.5 * EMU_PER_INCH),
}


def _next_shape_id(slide_root: ET.Element) -> int:
    ids: list[int] = []
    for node in slide_root.findall(".//p:cNvPr", NS):
        raw_id = node.attrib.get("id")
        if not raw_id:
            continue
        try:
            ids.append(int(raw_id))
        except ValueError:
            continue
    return max(ids or [1]) + 1


def _clamp_unit(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(0.0, min(1.0, number))


def _hex(value: Any, fallback: str) -> str:
    text = str(value or "").replace("#", "").strip().upper()
    if len(text) == 6 and all(char in "0123456789ABCDEF" for char in text):
        return text
    return fallback


def _emu(value: float, axis: str) -> str:
    return str(int(value * DEFAULT_CANVAS[axis]))


def _clamp_transparency(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(0.0, min(100.0, number))


def _add_solid_fill(parent: ET.Element, color: str, transparency: float = 0.0) -> None:
    fill = ET.SubElement(parent, _qn(NS["a"], "solidFill"))
    srgb = ET.SubElement(fill, _qn(NS["a"], "srgbClr"), {"val": color})
    if transparency > 0:
        ET.SubElement(srgb, _qn(NS["a"], "alpha"), {"val": str(int((100.0 - transparency) * 1000))})


def _add_text_body(shape: ET.Element, text: str, font_color: str, font_size: int) -> None:
    tx_body = ET.SubElement(shape, _qn(NS["p"], "txBody"))
    body_pr = ET.SubElement(tx_body, _qn(NS["a"], "bodyPr"), {"wrap": "square", "rtlCol": "0"})
    ET.SubElement(body_pr, _qn(NS["a"], "spAutoFit"))
    ET.SubElement(tx_body, _qn(NS["a"], "lstStyle"))
    paragraph = ET.SubElement(tx_body, _qn(NS["a"], "p"))
    for index, line in enumerate((text or "").splitlines() or [""]):
        if index > 0:
            paragraph = ET.SubElement(tx_body, _qn(NS["a"], "p"))
        run = ET.SubElement(paragraph, _qn(NS["a"], "r"))
        r_pr = ET.SubElement(run, _qn(NS["a"], "rPr"), {"lang": "zh-CN", "sz": str(int(font_size * 100))})
        _add_solid_fill(r_pr, font_color)
        text_node = ET.SubElement(run, _qn(NS["a"], "t"))
        text_node.text = line
    ET.SubElement(paragraph, _qn(NS["a"], "endParaRPr"), {"lang": "zh-CN", "sz": str(int(font_size * 100))})


def _add_shape(slide_root: ET.Element, shape_id: int, shape: dict[str, Any]) -> None:
    tree = slide_root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise RuntimeError("Slide is missing p:spTree; cannot add editable shape")

    kind = str(shape.get("kind") or "text")
    x = _clamp_unit(shape.get("x"), 0.08)
    y = _clamp_unit(shape.get("y"), 0.18)
    width = max(0.02, _clamp_unit(shape.get("width"), 0.32))
    height = max(0.02, _clamp_unit(shape.get("height"), 0.16))
    if x + width > 1:
        width = max(0.02, 1 - x)
    if y + height > 1:
        height = max(0.02, 1 - y)

    fill_color = _hex(shape.get("fill_color"), "FFF7EE")
    line_color = _hex(shape.get("line_color"), "DCAE80")
    font_color = _hex(shape.get("font_color"), "71472A")
    fill_transparency = _clamp_transparency(shape.get("fill_transparency"), 100.0 if kind == "text" else 0.0)
    line_transparency = _clamp_transparency(shape.get("line_transparency"), 100.0 if kind == "text" else 0.0)
    try:
        font_size = int(float(shape.get("font_size") or 13))
    except (TypeError, ValueError):
        font_size = 13
    font_size = max(9, min(28, font_size))
    text = str(shape.get("text") or "")
    if kind == "image_placeholder" and not text:
        text = "图片占位 / 图片建议"

    sp = ET.SubElement(tree, _qn(NS["p"], "sp"))
    nv_sp_pr = ET.SubElement(sp, _qn(NS["p"], "nvSpPr"))
    ET.SubElement(nv_sp_pr, _qn(NS["p"], "cNvPr"), {"id": str(shape_id), "name": f"Moonwalk {kind} {shape_id}"})
    ET.SubElement(nv_sp_pr, _qn(NS["p"], "cNvSpPr"), {"txBox": "1" if kind in {"text", "image_placeholder"} else "0"})
    ET.SubElement(nv_sp_pr, _qn(NS["p"], "nvPr"))

    sp_pr = ET.SubElement(sp, _qn(NS["p"], "spPr"))
    xfrm = ET.SubElement(sp_pr, _qn(NS["a"], "xfrm"))
    ET.SubElement(xfrm, _qn(NS["a"], "off"), {"x": _emu(x, "width"), "y": _emu(y, "height")})
    ET.SubElement(xfrm, _qn(NS["a"], "ext"), {"cx": _emu(width, "width"), "cy": _emu(height, "height")})
    prst_geom = ET.SubElement(sp_pr, _qn(NS["a"], "prstGeom"), {"prst": "roundRect" if kind == "image_placeholder" else "rect"})
    ET.SubElement(prst_geom, _qn(NS["a"], "avLst"))
    _add_solid_fill(sp_pr, fill_color, fill_transparency)
    line = ET.SubElement(sp_pr, _qn(NS["a"], "ln"), {"w": "12700"})
    _add_solid_fill(line, line_color, line_transparency)

    if kind in {"text", "image_placeholder"}:
        _add_text_body(sp, text, font_color, font_size)


def _apply_extra_shapes_to_slide(slide_root: ET.Element, extra_shapes: list[dict[str, Any]]) -> None:
    if not isinstance(extra_shapes, list):
        return
    shape_id = _next_shape_id(slide_root)
    for shape in extra_shapes[:8]:
        if not isinstance(shape, dict):
            continue
        _add_shape(slide_root, shape_id, shape)
        shape_id += 1
