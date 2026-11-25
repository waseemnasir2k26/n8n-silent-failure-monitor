"""Regenerate docs/*.png from examples/sample/*.html. Run `npm run demo` first if the samples changed.
Needs: pip install playwright, and Chrome at the path below (override with CHROME_PATH)."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
chrome = os.environ.get("CHROME_PATH", "C:/Program Files/Google/Chrome/Application/chrome.exe")
shots = [
    ("monthly-report.html", "monthly-report.png", 820),
    ("weekly-email.html", "weekly-email.png", 640),
]
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=chrome)
    for src, dst, width in shots:
        ctx = browser.new_context(viewport={"width": width, "height": 800}, device_scale_factor=2, color_scheme="light")
        page = ctx.new_page()
        page.goto((root / "examples" / "sample" / src).as_uri())
        page.screenshot(path=str(root / "docs" / dst), full_page=True)
        ctx.close()
        print("wrote docs/" + dst)
    browser.close()
