"""Make the on-dark versions of Glitchy: every mascot/glitchy*.png gets a white sticker outline,
saved to mascot/on-dark/. Glitchy's outline and limbs are the brand navy, so without this they
disappear on navy backgrounds.

    python assets/brand/glitchless/outline-mascots.py      (needs Pillow)
"""
import glob
import os

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PAD = 40  # room for the outline at the canvas edge

os.makedirs(os.path.join(HERE, 'mascot', 'on-dark'), exist_ok=True)
for src in sorted(glob.glob(os.path.join(HERE, 'mascot', 'glitchy*.png'))):
    im = Image.open(src).convert('RGBA')
    canvas = Image.new('RGBA', (im.width + 2 * PAD, im.height + 2 * PAD), (0, 0, 0, 0))
    canvas.paste(im, (PAD, PAD))
    alpha = canvas.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    # grow the silhouette ~22 px with round corners: blur, then a soft threshold for anti-aliased edges
    grown = alpha.filter(ImageFilter.GaussianBlur(14)).point(lambda v: 0 if v < 6 else 255 if v > 30 else int((v - 6) * 255 / 24))
    sticker = Image.new('RGBA', canvas.size, (255, 255, 255, 0))
    sticker.putalpha(grown)
    dst = os.path.join(HERE, 'mascot', 'on-dark', os.path.basename(src))
    Image.alpha_composite(sticker, canvas).save(dst)
    print(os.path.relpath(dst, HERE))
