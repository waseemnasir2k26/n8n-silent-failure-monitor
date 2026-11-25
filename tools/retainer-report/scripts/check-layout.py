"""Renders monthly-report.html with a 200-character unbroken label and asserts no horizontal overflow.
Run: python scripts/check-layout.py   (needs Python Playwright and Chrome; CHROME_PATH overrides the default)"""
import json, os, subprocess, sys, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
chrome = os.environ.get("CHROME_PATH", "C:/Program Files/Google/Chrome/Application/chrome.exe")
tmp = Path(tempfile.mkdtemp())
cfg = json.loads((root / "examples" / "sample.config.json").read_text(encoding="utf8"))
cfg["client"] = "C" * 200
cfg["workflows"][0]["label"] = "W" * 200
(tmp / "c.json").write_text(json.dumps(cfg), encoding="utf8")
subprocess.run(["node", str(root / "bin" / "n8n-retainer-report.js"), "--config", str(tmp / "c.json"),
                "--from-file", str(root / "examples" / "sample-executions.json"), "--out", str(tmp / "out"),
                "--end", "2026-10-24"], check=True, capture_output=True)
ok = True
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=chrome)
    for width in (900, 480):
        pg = b.new_page(viewport={"width": width, "height": 900})
        pg.goto((tmp / "out" / "monthly-report.html").as_uri())
        sw = pg.evaluate("document.documentElement.scrollWidth")
        print(f"viewport {width}: scrollWidth {sw}")
        ok = ok and sw <= width + 2
    b.close()
sys.exit(0 if ok else 1)
