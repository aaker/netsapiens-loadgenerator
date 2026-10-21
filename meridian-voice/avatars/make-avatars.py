#!/usr/bin/env python3
#
# make-avatars.py - draw the Meridian Voice agents' avatars as SVG
# portraits (no dependencies), then render each to a 512x512 PNG with
# render-svg.swift (macOS). The PNGs are committed; build-domain.js uploads
# them as the users' avatars.
#
# Usage (from meridian-voice/avatars, on macOS):
#   ./make-avatars.py
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

# One entry per agent: colors and a hair style. Shapes are drawn on a
# 512x512 canvas, centered.
AGENTS = {
    'priya-shah': dict(bg='#0f766e', skin='#b07850', skin_shade='#966040', hair='#1b120d',
                       hair_style='long', shirt='#f4c95d', collar='#e0b040', glasses=False,
                       lips='#9b4a3c', earrings='#f4c95d'),
    'marcus-reed': dict(bg='#1e3a8a', skin='#6b4430', skin_shade='#583626', hair='#151010',
                        hair_style='short', shirt='#7dd3fc', collar='#5bb8e8', glasses=False,
                        lips='#4a2a20', beard=True),
    'dana-ortiz': dict(bg='#9a3412', skin='#d29a72', skin_shade='#bb835d', hair='#4a2c1d',
                       hair_style='curly', shirt='#a7f3d0', collar='#86dcb6', glasses=True,
                       lips='#a6524a'),
    'owen-hale': dict(bg='#4c1d95', skin='#e8b896', skin_shade='#d39f7c', hair='#8a5a2b',
                      hair_style='short', shirt='#fde68a', collar='#f5d36a', glasses=True,
                      lips='#b0645a'),
}


def hair_back(a):
    if a['hair_style'] == 'long':
        return f'<path d="M150 230 Q150 110 256 104 Q362 110 362 230 L372 400 Q256 430 140 400 Z" fill="{a["hair"]}"/>'
    if a['hair_style'] == 'curly':
        circles = ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{a["hair"]}"/>'
                          for x, y, r in [(170, 200, 52), (205, 150, 55), (256, 128, 58), (307, 150, 55),
                                          (342, 200, 52), (160, 260, 46), (352, 260, 46), (172, 315, 40),
                                          (340, 315, 40)])
        return circles
    return ''


def hair_front(a):
    if a['hair_style'] == 'long':
        return (f'<path d="M168 210 Q180 128 256 124 Q330 128 344 210 Q300 160 256 168 '
                f'Q214 160 168 210 Z" fill="{a["hair"]}"/>')
    if a['hair_style'] == 'curly':
        return ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{a["hair"]}"/>'
                       for x, y, r in [(200, 170, 30), (236, 156, 30), (276, 156, 30), (312, 170, 30)])
    # short: a close crop following the top of the head
    return (f'<path d="M172 222 Q170 132 256 126 Q342 132 340 222 Q326 170 256 166 '
            f'Q186 170 172 222 Z" fill="{a["hair"]}"/>')


def svg(a):
    beard = ''
    if a.get('beard'):
        beard = (f'<path d="M190 282 Q196 352 256 362 Q316 352 322 282 Q306 330 256 334 '
                 f'Q206 330 190 282 Z" fill="{a["hair"]}" opacity="0.9"/>')
    glasses = ''
    if a.get('glasses'):
        glasses = ('<g fill="none" stroke="#1f2937" stroke-width="6">'
                   '<rect x="196" y="234" width="50" height="38" rx="12"/>'
                   '<rect x="266" y="234" width="50" height="38" rx="12"/>'
                   '<path d="M246 250 Q256 244 266 250"/></g>')
    earrings = ''
    if a.get('earrings'):
        earrings = (f'<circle cx="176" cy="300" r="7" fill="{a["earrings"]}"/>'
                    f'<circle cx="336" cy="300" r="7" fill="{a["earrings"]}"/>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><clipPath id="c"><circle cx="256" cy="256" r="256"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="512" height="512" fill="{a['bg']}"/>
    <circle cx="256" cy="256" r="236" fill="#ffffff" opacity="0.06"/>
    {hair_back(a)}
    <path d="M86 512 Q96 400 196 372 L316 372 Q416 400 426 512 Z" fill="{a['shirt']}"/>
    <path d="M214 372 L256 420 L298 372 Z" fill="{a['collar']}"/>
    <rect x="222" y="320" width="68" height="62" rx="24" fill="{a['skin_shade']}"/>
    <ellipse cx="176" cy="266" rx="18" ry="28" fill="{a['skin_shade']}"/>
    <ellipse cx="336" cy="266" rx="18" ry="28" fill="{a['skin_shade']}"/>
    <ellipse cx="256" cy="252" rx="84" ry="104" fill="{a['skin']}"/>
    {hair_front(a)}
    <path d="M200 224 Q220 212 240 222" fill="none" stroke="{a['hair']}" stroke-width="7" stroke-linecap="round"/>
    <path d="M272 222 Q292 212 312 224" fill="none" stroke="{a['hair']}" stroke-width="7" stroke-linecap="round"/>
    <ellipse cx="221" cy="254" rx="9" ry="11" fill="#1f2937"/>
    <ellipse cx="291" cy="254" rx="9" ry="11" fill="#1f2937"/>
    <circle cx="224" cy="250" r="3" fill="#ffffff"/>
    <circle cx="294" cy="250" r="3" fill="#ffffff"/>
    {glasses}
    <path d="M256 262 Q250 286 260 292" fill="none" stroke="{a['skin_shade']}" stroke-width="5" stroke-linecap="round"/>
    <ellipse cx="200" cy="292" rx="16" ry="9" fill="#e07a6a" opacity="0.25"/>
    <ellipse cx="312" cy="292" rx="16" ry="9" fill="#e07a6a" opacity="0.25"/>
    {beard}
    <path d="M226 312 Q256 336 286 312" fill="none" stroke="{a['lips']}" stroke-width="7" stroke-linecap="round"/>
    {earrings}
  </g>
</svg>
'''


def main():
    for name, a in AGENTS.items():
        path = os.path.join(HERE, f'{name}.svg')
        with open(path, 'w') as f:
            f.write(svg(a))
        png = os.path.join(HERE, f'{name}.png')
        subprocess.run(['swift', os.path.join(HERE, 'render-svg.swift'), path, png], check=True)
        print(f'{png}')


if __name__ == '__main__':
    main()
