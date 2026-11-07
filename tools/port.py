#!/usr/bin/env python3
"""Turn the Claude artifact version of the schedule into the Firebase web app page.

Usage: python3 tools/port.py tools/artifact-source.html public/index.html

The artifact stays the source of truth for the screens. This script makes the
small, checked edits the Firebase version needs (texted-code sign-in, texts on
publish, phone numbers, no Drive or Gmail), so a later artifact change can be
carried over by saving the new artifact source and running this again.
Every edit must match exactly once, or the script stops.
"""
import re
import sys

src, out = sys.argv[1], sys.argv[2]
h = open(src, encoding="utf-8").read()


def sub(old, new, count=1, regex=False):
    global h
    n = len(re.findall(old, h)) if regex else h.count(old)
    if n != count:
        sys.exit(f"port.py: expected {count} match(es), found {n}:\n  {old[:120]}")
    h = re.sub(old, lambda m: new, h) if regex else h.replace(old, new)


# 1. Proper document head (the saved artifact puts the page inside a wrapper body).
sub(r"^<!doctype html><html><head>.*?</head><body>\n", "", regex=True)
h = h.replace("</body></html>", "")
sub('<header class="top">', "</head>\n<body>\n<header class=\"top\">")
h = (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n"
    "<meta name=\"theme-color\" content=\"#0d6a61\">\n"
    "<link rel=\"manifest\" href=\"/manifest.webmanifest\">\n"
    "<link rel=\"icon\" href=\"/icon.svg\" type=\"image/svg+xml\">\n"
    "<link rel=\"apple-touch-icon\" href=\"/icon-192.png\">\n"
    "<style>body{margin:0}[hidden]:not([hidden=until-found i]){display:none!important}</style>\n"
    + h.rstrip() + "\n</body>\n</html>\n"
)

# 2. Load the Firebase layer first; the app starts once sign-in is done.
sub("\n<script>\n(() => {", "\n<script>window.GSS_FIREBASE = true; window.__gssReady = new Promise(r => window.__gssResolve = r);</script>\n<script type=\"module\" src=\"/fb.js\"></script>\n<script>\n(() => {")
sub("\ninit();\n})();", "\nwindow.__gssReady.then(init);\n})();")

# 3. Publishing sends texts instead of saving to Google Drive.
sub('"Staff will see these on their schedule the next time they open this page."',
    '"Everyone on these shifts gets a text with their schedule for the week."')
sub("if (n && !S.demo && driveAuto()) {",
    "if (n && !S.demo) put(\"publishEvents\", gid(), {week:S.ws, locs:[...new Set(d.map(s=>s.loc))], shiftIds:d.map(s=>s.id), by:S.uid||null, ts:Date.now()});\n    if (false) {")
sub(r'\n    <div class="checks"><label><input type="checkbox" id="pr-auto".*?</label></div>', "", regex=True)
sub('<button class="btn" data-act="doDrive">Save to Google Drive</button>', "")

# 4. No Gmail checks in this version.
sub("function emailTick(){ if (S.demo ||", "function emailTick(){ if (window.GSS_FIREBASE || S.demo ||")
sub('<span class="muted" style="font-size:13px">${esc(emailStatus())}</span><button class="btn" data-act="checkEmail" ${EM.busy?"disabled":""}>${EM.busy?"Checking email…":"Check email now"}</button>', "")

# 5. People are linked by their phone number, not by picking a name.
sub('else if (!S.noDb && S.uid && canAct()) who =', 'else if (!window.GSS_FIREBASE && !S.noDb && S.uid && canAct()) who =')
sub(r'return `<div class="hero-empty"><h2>Link your name to see your shifts</h2>.*?</div></div>`;',
    'return `<div class="hero-empty"><h2>Your account isn\'t matched to a team member</h2><p class="muted">Ask a manager to check that your cell number is on your Team profile, then sign out and back in.</p></div>`;', regex=True)
sub(r'<p class="muted" style="font-size:13px;max-width:70ch">“Linked” means.*?</p>`;',
    '<p class="muted" style="font-size:13px;max-width:70ch">“Linked” means that person has signed in with the cell number on their profile. Add a cell number to send them schedule texts and let them sign in.</p>`;', regex=True)
sub("Linked to a viewer account.", "Signed in on their phone.")
sub('<h2>The shared schedule can\'t load here</h2><p class="muted">Open this page from claude.ai while signed in to see your team\'s schedule. You can still explore how it works with sample data.</p>',
    '<h2>The schedule can\'t load right now</h2><p class="muted">Check your connection and reload. If it keeps happening, sign out and back in.</p>')

# 6. Cell number on each team member (kept private to managers by the data layer).
sub('<label class="f">Max hours / week<input type="number" name="maxHours" id="st-max"',
    '<label class="f">Cell phone (texts &amp; sign-in)<input type="tel" name="phone" id="st-phone" autocomplete="off" value="${esc(s.phone||"")}" placeholder="816-555-0123"></label>\n      <label class="f">Max hours / week<input type="number" name="maxHours" id="st-max"')
sub('maxHours: d.get("maxHours")===""?null:+d.get("maxHours"), active: d.get("active")==="on"};',
    'maxHours: d.get("maxHours")===""?null:+d.get("maxHours"), active: d.get("active")==="on", phone: (d.get("phone")||"").trim()};')

sub('closeModal(); await put("staff", id, data); toast(`${name} saved`);', 'closeModal(); if (await put("staff", id, data)) toast(`${name} saved`);')

# Employees land on their own shifts the first time.
sub('  if (!db){ S.noDb = true; render(); return; }', '  if (!db){ S.noDb = true; render(); return; }\n  if (store.get("tab", null) == null) S.tab = (S.owner || S.admin) ? "schedule" : "mine";')

# 7. Permission errors say what happened.
sub('if (e && e.code === "invalid_argument") {', 'if (e && (e.code === "invalid_argument" || e.code === "permission-denied")) {')
sub("Ask the owner for Contributor access.\"); render(); }", "Ask a manager if you need this.\"); render(); }\n  else if (e && e.code === \"bad-phone\") toast(\"That cell number doesn't look right. Use a 10-digit number.\");")

open(out, "w", encoding="utf-8").write(h)

# The owner tools page reuses the app's look.
import os
css = re.findall(r"<style>\n(/\* Layout:.*?)</style>", h, re.S)
if len(css) != 1:
    sys.exit("port.py: couldn't find the app stylesheet")
fonts = re.search(r'<link rel="stylesheet" href="(https://fonts.googleapis.com[^"]+)">', h).group(1)
open(os.path.join(os.path.dirname(out), "admin.html"), "w", encoding="utf-8").write(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner tools · Ginger Sue's Schedule</title><meta name="robots" content="noindex">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{fonts}">
<style>body{{margin:0}}[hidden]{{display:none!important}}
{css[0]}</style></head>
<body><header class="top"><div class="wrap"><div class="bar"><div class="brand"><b>Ginger Sue's <i>Owner tools</i></b></div></div></div></header>
<main class="wrap" id="app" style="padding-top:16px"></main>
<script type="module" src="/admin.js"></script>
</body></html>
""")
print(f"wrote {out} ({len(h):,} bytes)")
