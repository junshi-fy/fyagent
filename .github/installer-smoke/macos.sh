#!/usr/bin/env bash
# Installer smoke test on a throwaway GitHub-hosted macOS VM.
# Phases: install | probe <label> | tools | opencode-desktop
# Env: SMOKE_OUT, SMOKE_ASSET (verified dmg path)
set -uo pipefail
PHASE="${1:?phase}"
LABEL="${2:-probe}"
OUT="${SMOKE_OUT:?}"
mkdir -p "$OUT"
APP="/Applications/FyAgent.app"


shot() {
  local name="$1"
  if screencapture -x "$OUT/$name" 2>"$OUT/$name.err"; then echo "ok"; else echo "failed: $(cat "$OUT/$name.err")"; fi
}

case "$PHASE" in
  install)
    MNT="$(mktemp -d /tmp/fyagent-dmg.XXXX)"
    START=$(date +%s)
    hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$SMOKE_ASSET" > "$OUT/hdiutil-attach.log" 2>&1
    ATTACH=$?
    ls -la "$MNT" > "$OUT/dmg-contents.txt" 2>&1
    SRC_APP="$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)"
    rm -rf "$APP"
    cp -R "$SRC_APP" /Applications/ 2>"$OUT/copy.err"
    COPY=$?
    hdiutil detach "$MNT" >/dev/null 2>&1
    END=$(date +%s)
    codesign -dv --verbose=4 "$APP" > "$OUT/codesign-display.txt" 2>&1
    codesign --verify --deep --strict --verbose=2 "$APP" > "$OUT/codesign-verify.txt" 2>&1; CS_VERIFY=$?
    spctl -a -vv -t exec "$APP" > "$OUT/spctl.txt" 2>&1; SPCTL=$?
    xcrun stapler validate "$APP" > "$OUT/stapler.txt" 2>&1; STAPLER=$?
    xattr -l "$APP" > "$OUT/xattr.txt" 2>&1
    MAIN_BIN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null)"
    lipo -info "$APP/Contents/MacOS/$MAIN_BIN" > "$OUT/lipo.txt" 2>&1
    python3 - "$OUT" "$APP" "$MAIN_BIN" "$ATTACH" "$COPY" "$CS_VERIFY" "$SPCTL" "$STAPLER" "$((END-START))" "$SRC_APP" <<'PY'
import json, plistlib, platform, subprocess, sys, os
out, app, main_bin, attach, copy, csv, spctl, stapler, secs, src = sys.argv[1:]
info = {}
try:
    with open(os.path.join(app, "Contents/Info.plist"), "rb") as f:
        p = plistlib.load(f)
    info = {k: p.get(k) for k in ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "LSMinimumSystemVersion", "CFBundleExecutable"]}
except Exception as e:
    info = {"error": str(e)}
read = lambda n: open(os.path.join(out, n), encoding="utf-8", errors="replace").read().strip()
res = {
    "phase": "install", "method": "hdiutil attach + cp -R to /Applications",
    "sourceApp": src, "installLocation": app, "exe": os.path.join(app, "Contents/MacOS", main_bin),
    "macos": platform.mac_ver()[0], "machine": platform.machine(),
    "hdiutilAttachExit": int(attach), "copyExit": int(copy), "installSeconds": int(secs),
    "infoPlist": info,
    "codesignDisplay": read("codesign-display.txt"), "codesignVerifyExit": int(csv), "codesignVerify": read("codesign-verify.txt"),
    "spctlExit": int(spctl), "spctl": read("spctl.txt"), "staplerExit": int(stapler), "stapler": read("stapler.txt"),
    "lipo": read("lipo.txt"), "xattr": read("xattr.txt"),
}
res["ok"] = res["hdiutilAttachExit"] == 0 and res["copyExit"] == 0 and os.path.exists(res["exe"])
json.dump(res, open(os.path.join(out, "install.json"), "w"), indent=2, ensure_ascii=False)
print(json.dumps(res, indent=2, ensure_ascii=False))
sys.exit(0 if res["ok"] else 1)
PY
    ;;

  probe)
    EXE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["exe"])' "$OUT/install.json")"
    STARTED="$(date -u +%FT%TZ)"
    # Launch the installed binary directly so its stdout log target is captured.
    "$EXE" > "$OUT/app-stdout-$LABEL.log" 2> "$OUT/app-stderr-$LABEL.log" &
    PID=$!
    sleep 25
    ALIVE20=false; kill -0 "$PID" 2>/dev/null && ALIVE20=true
    osascript -e 'tell application "System Events" to get name of every process whose background only is false' > "$OUT/ax-processes-$LABEL.txt" 2>&1; AX=$?
    osascript -e 'tell application "System Events" to tell process "FyAgent" to get {name, position, size} of every window' > "$OUT/ax-windows-$LABEL.txt" 2>&1
    osascript -e 'tell application "FyAgent" to activate' >/dev/null 2>&1
    sleep 5
    SHOT="$(shot "desktop-$LABEL.png")"
    ALIVE_AFTER=false; kill -0 "$PID" 2>/dev/null && ALIVE_AFTER=true
    osascript -e 'tell application "FyAgent" to quit' >/dev/null 2>&1
    sleep 5
    kill "$PID" 2>/dev/null; sleep 2; kill -9 "$PID" 2>/dev/null
    STILL=false; pgrep -f "$EXE" >/dev/null && STILL=true
    if [ -d "$HOME/.fyagent/logs" ]; then mkdir -p "$OUT/fyagent-logs-$LABEL"; cp -R "$HOME/.fyagent/logs/." "$OUT/fyagent-logs-$LABEL/"; fi
    python3 - "$OUT" "$LABEL" "$EXE" "$STARTED" "$ALIVE20" "$ALIVE_AFTER" "$STILL" "$SHOT" "$AX" <<'PY'
import json, os, sys
out, label, exe, started, a20, aafter, still, shot, ax = sys.argv[1:]
read = lambda n: open(os.path.join(out, n), encoding="utf-8", errors="replace").read().strip() if os.path.exists(os.path.join(out, n)) else None
res = {"phase": "probe", "label": label, "exe": exe, "startedAt": started,
       "aliveAfter20s": a20 == "true", "aliveAfterProbe": aafter == "true", "stillRunningAfterQuit": still == "true",
       "desktopScreenshot": f"desktop-{label}.png", "screenshotResult": shot,
       "accessibilityScriptingExit": int(ax), "axProcesses": read(f"ax-processes-{label}.txt"), "axWindows": read(f"ax-windows-{label}.txt"),
       "cdpAvailable": False, "note": "WKWebView exposes no DevTools protocol in release builds; detection evidence on macOS is screenshot + logs + filesystem checks."}
json.dump(res, open(os.path.join(out, f"launch-{label}.json"), "w"), indent=2, ensure_ascii=False)
print(json.dumps(res, indent=2, ensure_ascii=False))
PY
    ;;

  tools)
    export npm_config_loglevel=error
    : > "$OUT/tools.tsv"
    for spec in "codex @openai/codex codex" "claude @anthropic-ai/claude-code claude" "gemini @google/gemini-cli gemini" \
                "opencode @opencode/cli opencode" "grok @xai-official/grok grok" "openclaw openclaw openclaw"; do
      set -- $spec
      S=$(date +%s)
      npm install -g "$2@latest" > "$OUT/npm-install-$1.log" 2>&1; CODE=$?
      VER="$("$3" --version 2>&1 | head -3 | tr '\n' ' ')"
      WHERE="$(command -v "$3" || true)"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$CODE" "$(( $(date +%s) - S ))" "$VER" "$WHERE" >> "$OUT/tools.tsv"
    done
    python3 - "$OUT" <<'PY'
import json, os, subprocess, sys
out = sys.argv[1]
rows = []
for line in open(os.path.join(out, "tools.tsv"), encoding="utf-8"):
    t, pkg, code, secs, ver, where = (line.rstrip("\n").split("\t") + [""] * 6)[:6]
    rows.append({"tool": t, "pkg": pkg, "npmExit": int(code), "seconds": int(secs), "versionOutput": ver.strip(), "where": where})
prefix = subprocess.run(["npm", "prefix", "-g"], capture_output=True, text=True).stdout.strip()
node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
json.dump({"npmPrefix": prefix, "node": node, "results": rows}, open(os.path.join(out, "tools-install.json"), "w"), indent=2)
for r in rows: print(r)
PY
    ;;

  opencode-desktop)
    URL="https://opencode.ai/download/stable/darwin-aarch64-dmg"
    DMG="$OUT/assets/opencode-desktop.dmg"
    mkdir -p "$OUT/assets"
    FINAL="$(curl -fsSL -o "$DMG" -w '%{url_effective}' "$URL" 2>"$OUT/opencode-download.err")"; DL=$?
    SHA=""; SIZE=""
    [ -f "$DMG" ] && SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)" && SIZE="$(stat -f %z "$DMG")"
    MNT="$(mktemp -d /tmp/opencode-dmg.XXXX)"
    hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" > "$OUT/opencode-attach.log" 2>&1
    SRC="$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)"
    cp -R "$SRC" /Applications/ 2>"$OUT/opencode-copy.err"; COPY=$?
    hdiutil detach "$MNT" >/dev/null 2>&1
    DEST="/Applications/$(basename "$SRC")"
    codesign -dv --verbose=2 "$DEST" > "$OUT/opencode-codesign.txt" 2>&1
    spctl -a -vv -t exec "$DEST" > "$OUT/opencode-spctl.txt" 2>&1
    python3 - "$OUT" "$URL" "$FINAL" "$DL" "$SHA" "$SIZE" "$SRC" "$DEST" "$COPY" <<'PY'
import json, os, plistlib, sys
out, url, final, dl, sha, size, src, dest, copy = sys.argv[1:]
info = {}
try:
    with open(os.path.join(dest, "Contents/Info.plist"), "rb") as f:
        p = plistlib.load(f)
    info = {k: p.get(k) for k in ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "CFBundleName"]}
except Exception as e:
    info = {"error": str(e)}
read = lambda n: open(os.path.join(out, n), encoding="utf-8", errors="replace").read().strip()
res = {"phase": "opencode-desktop", "sourceUrl": url, "finalUrl": final, "downloadExit": int(dl), "dmgSha256": sha, "dmgSize": size,
       "sourceApp": src, "installedApp": dest, "copyExit": int(copy), "infoPlist": info,
       "expectedBundleIdInCode": "ai.opencode.desktop",
       "bundleIdMatchesCode": info.get("CFBundleIdentifier") == "ai.opencode.desktop",
       "codesign": read("opencode-codesign.txt"), "spctl": read("opencode-spctl.txt")}
json.dump(res, open(os.path.join(out, "opencode-desktop.json"), "w"), indent=2, ensure_ascii=False)
print(json.dumps(res, indent=2, ensure_ascii=False))
PY
    ;;

  *) echo "unknown phase $PHASE"; exit 2 ;;
esac
