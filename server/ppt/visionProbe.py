"""A fresh image-only challenge detects endpoints that silently ignore images."""
import base64
import io
import json
import secrets
from PIL import Image, ImageDraw, ImageFont

code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
image = Image.new("RGB", (700, 160), "white")
ImageDraw.Draw(image).text((30, 40), code, font=ImageFont.load_default(size=64), fill="black")
output = io.BytesIO()
image.save(output, format="PNG")
print(json.dumps({"code": code, "image": base64.b64encode(output.getvalue()).decode("ascii")}))
