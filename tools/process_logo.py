from PIL import Image
import os

src = r"C:\Users\Kavithayappa\Documents\chhaperia material\logo\chhaperia PNG.png"
base = r"C:\Users\Kavithayappa\chhaperia-erp\assets"
os.makedirs(base, exist_ok=True)

im = Image.open(src).convert("RGBA")
W, H = im.size

# 1) Full logo (transparent) - used on dark sidebar
im.save(os.path.join(base, "logo-full.png"))

# 2) Crop just the orange/red mark (left ~23% of width holds the C+diamond)
#    Find bounding box of non-transparent, non-white-ish, colored pixels on the left.
px = im.load()
minx, miny, maxx, maxy = W, H, 0, 0
for y in range(0, H, 3):
    for x in range(0, int(W*0.30), 3):
        r,g,b,a = px[x,y]
        if a > 120 and not (r>235 and g>235 and b>235):
            if x<minx: minx=x
            if y<miny: miny=y
            if x>maxx: maxx=x
            if y>maxy: maxy=y
pad = 20
minx=max(0,minx-pad); miny=max(0,miny-pad); maxx=min(W,maxx+pad); maxy=min(H,maxy+pad)
mark = im.crop((minx,miny,maxx,maxy))
mark.save(os.path.join(base, "mark.png"))

# 3) Square favicon from the mark on transparent, centered
side = max(mark.size)
sq = Image.new("RGBA", (side, side), (0,0,0,0))
sq.paste(mark, ((side-mark.size[0])//2, (side-mark.size[1])//2), mark)
for s in (32, 64, 180, 256):
    sq.resize((s,s), Image.LANCZOS).save(os.path.join(base, f"favicon-{s}.png"))
sq.resize((64,64), Image.LANCZOS).save(os.path.join(base, "favicon.png"))

print("mark crop box:", (minx,miny,maxx,maxy), "mark size:", mark.size)
print("done")
