# Screenshots and promo tiles to 24-bit PNG (no alpha channel), which the
# Chrome Web Store asks for. Icons keep their transparency.
# Usage: python store-assets/tools/flatten.py
import pathlib
from PIL import Image

ASSETS = pathlib.Path(__file__).resolve().parent.parent
PAPER = (244, 241, 233)

for store in ('chrome', 'firefox', 'edge'):
    for f in sorted((ASSETS / store).glob('*.png')):
        if f.name.startswith(('icon-', 'logo-')):
            continue
        im = Image.open(f)
        if im.mode != 'RGB':
            ground = Image.new('RGB', im.size, PAPER)
            ground.paste(im, mask=im.convert('RGBA').getchannel('A'))
            im = ground
        im.save(f, optimize=True)
        print(f'  {store}/{f.name}: {im.size[0]}x{im.size[1]} {im.mode}')
