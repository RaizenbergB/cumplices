"""Gera o PDF do kit para imprimir a partir do kit.html (feito por kit-html.mjs).
Uso: node ferramentas/kit-html.mjs && python3 ferramentas/kit.py
"""
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / 'kit-build' / 'kit.html'
OUT = ROOT / 'site-base' / 'kit' / 'cumplices-kit-para-imprimir.pdf'

subprocess.run(['node', str(ROOT / 'ferramentas' / 'kit-html.mjs'), str(HTML)], check=True)
OUT.parent.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.goto(HTML.as_uri())
    pg.wait_for_timeout(500)
    pg.evaluate('document.fonts.ready')
    pg.pdf(path=str(OUT), format='A4', print_background=True, prefer_css_page_size=True,
           margin={'top': '0', 'right': '0', 'bottom': '0', 'left': '0'})
    b.close()
print('PDF:', OUT, os.path.getsize(OUT) // 1024, 'KB')
