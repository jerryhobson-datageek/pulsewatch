# -*- coding: utf-8 -*-
import sys, os, time
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

OUT = r"C:\claudcode\docs\screenshots"
os.makedirs(OUT, exist_ok=True)

def ss(page, name):
    p = os.path.join(OUT, name)
    page.screenshot(path=p)
    print(f"  saved: {name}")

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)

    # ── Dark mode ─────────────────────────────────────────────────────────────
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto("http://2.24.107.27:3000")
    page.wait_for_selector("#loginOverlay:not(.hidden)", timeout=8000)

    # Login screen
    ss(page, "01_login.png")
    print("Login screen captured")

    # Log in
    page.fill("#loginUser", "viewer")
    page.fill("#loginPass", "viewer123")
    page.click("#loginBtn")
    page.wait_for_selector(".monitor-card", timeout=10000)
    time.sleep(2)  # let charts settle

    # Dashboard — dark
    ss(page, "02_dashboard_dark.png")
    print("Dashboard dark captured")

    # History modal — dark
    page.query_selector_all(".monitor-card")[0].click()
    page.wait_for_selector("#histModal.open", timeout=5000)
    time.sleep(1)
    ss(page, "03_history_modal_dark.png")
    print("History modal dark captured")

    # 7d view
    page.click("#histBtn7d")
    time.sleep(1)
    ss(page, "04_history_modal_7d.png")
    print("History modal 7d captured")

    page.keyboard.press("Escape")
    time.sleep(0.3)

    # ── Light mode ────────────────────────────────────────────────────────────
    page.evaluate("localStorage.setItem('pw_theme','light'); document.documentElement.setAttribute('data-theme','light')")
    time.sleep(0.5)
    ss(page, "05_dashboard_light.png")
    print("Dashboard light captured")

    # History modal — light
    page.query_selector_all(".monitor-card")[0].click()
    page.wait_for_selector("#histModal.open", timeout=5000)
    time.sleep(1)
    ss(page, "06_history_modal_light.png")
    print("History modal light captured")

    page.keyboard.press("Escape")

    browser.close()
    print("\nAll screenshots saved to docs/screenshots/")
