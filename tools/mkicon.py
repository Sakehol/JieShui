from PIL import Image, ImageDraw, ImageFilter

S = 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 背景：深色圆角方块，带一点径向渐变感（用两层圆角矩形叠出）
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=(13, 20, 30, 255))
d.rounded_rectangle([int(S * 0.055)] * 2 + [int(S * 0.945)] * 2, radius=int(S * 0.19), fill=(17, 27, 40, 255))

# 水滴：圆 + 顶部三角，用平滑的连接
cx = S / 2
body_cy = S * 0.585
r = S * 0.215
blue = (47, 156, 244, 255)
blue_d = (26, 116, 196, 255)

# 尖顶三角（顶端 y = S*0.185）
tip_y = S * 0.185
base_y = body_cy - r * 0.42
half = r * 0.80
d.polygon([(cx, tip_y), (cx + half, base_y), (cx - half, base_y)], fill=blue)
# 圆体
d.ellipse([cx - r, body_cy - r, cx + r, body_cy + r], fill=blue)
# 把三角与圆的接缝抹平
d.ellipse([cx - half * 0.98, base_y - r * 0.30, cx + half * 0.98, base_y + r * 0.30], fill=blue)

# 高光
hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
hd.ellipse([cx - r * 0.55, body_cy - r * 0.62, cx - r * 0.06, body_cy - r * 0.10], fill=(255, 255, 255, 120))
hl = hl.filter(ImageFilter.GaussianBlur(S * 0.012))
img = Image.alpha_composite(img, hl)

img.save('icon-512.png')
img.resize((192, 192), Image.LANCZOS).save('icon-192.png')
print('ok')
