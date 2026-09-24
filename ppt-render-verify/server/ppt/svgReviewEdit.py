"""Restricted atomic geometry edits. No content, color, structure or ID mutations."""
import json
import math
import sys
from lxml import etree

request = json.load(sys.stdin)
parser = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
root = etree.fromstring(request["svg"].encode("utf-8"), parser)
elements = [node for node in root.iter() if isinstance(node.tag, str)]
if request["action"] == "inspect":
    print(json.dumps([{"index": i, "tag": etree.QName(node).localname, "id": node.get("id"),
                       "attributes": dict(node.attrib), "text": "".join(node.itertext())[:300]}
                      for i, node in enumerate(elements) if etree.QName(node).localname in {"text", "tspan", "rect", "circle"}]))
else:
    edits = request["edits"]
    if not isinstance(edits, list) or len(edits) > 32:
        raise ValueError("Too many edits")
    seen = set()
    for edit in edits:
        index, attribute = edit["index"], edit["attribute"]
        if type(index) is not int or index <= 0 or index >= len(elements) or (index, attribute) in seen:
            raise ValueError("Invalid or duplicate target")
        seen.add((index, attribute))
        node = elements[index]
        tag = etree.QName(node).localname
        allowed = {"text": {"x", "y", "dx", "dy", "font-size", "letter-spacing"},
                   "tspan": {"x", "y", "dx", "dy", "font-size", "letter-spacing"},
                   "rect": {"x", "y"}, "circle": {"cx", "cy"}}
        if attribute not in allowed.get(tag, set()) or node.get(attribute) != edit["before"]:
            raise ValueError("Attribute forbidden, inherited, or changed")
        before, after = float(edit["before"]), float(edit["after"])
        if not math.isfinite(after) or abs(after - before) > (2 if attribute in {"font-size", "letter-spacing"} else 200):
            raise ValueError("Edit exceeds atomic geometry allowance")
        if attribute == "font-size" and after <= 0:
            raise ValueError("Invalid font size")
        node.set(attribute, edit["after"])
    print(json.dumps({"svg": etree.tostring(root, encoding="unicode")}))
