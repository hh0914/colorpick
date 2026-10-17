"""生成 ColorPick 拾色助手扩展图标（临时脚本，不随扩展发布）"""
import os
import numpy as np
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
os.makedirs(OUT, exist_ok=True)

S = 512
yy, xx = np.mgrid[0:S, 0:S]
t = (xx + yy) / (2 * (S - 1))
c1 = np.array([124, 92, 255], dtype=np.float64)
c2 = np.array([255, 107, 203], dtype=np.float64)
rgb = (c1[None, None, :] * (1 - t[..., None]) + c2[None, None, :] * t[..., None]).astype(np.uint8)
img = Image.fromarray(rgb, "RGB").convert("RGBA")

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)
img.putalpha(mask)

# 2x2 白色色板
overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)
cell = int(S * 0.185)
gap = int(S * 0.075)
total = cell * 2 + gap
x0 = (S - total) // 2
y0 = (S - total) // 2
alphas = [(255, 255), (255, 205), (255, 205), (255, 235)]
for i in range(2):
    for j in range(2):
        a = alphas[i * 2 + j][0]
        left = x0 + j * (cell + gap)
        top = y0 + i * (cell + gap)
        d.rounded_rectangle(
            [left, top, left + cell, top + cell],
            radius=int(cell * 0.3),
            fill=(255, 255, 255, a),
        )
img = Image.alpha_composite(img, overlay)

for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))

print("icons generated:", ", ".join(sorted(os.listdir(OUT))))
