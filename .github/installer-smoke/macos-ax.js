// JXA helper (osascript -l JavaScript) for the macOS smoke VM.
// Uses the Accessibility tree of the running FyAgent window, which exposes the
// WKWebView content as AX elements. Only reads text and clicks visible
// navigation buttons (no install/update actions).
//   osascript -l JavaScript macos-ax.js dump
//   osascript -l JavaScript macos-ax.js click "<exact text>"
function run(argv) {
  const mode = argv[0] || "dump";
  const target = argv[1] || "";
  const se = Application("System Events");
  const procs = se.processes.whose({ name: "fyagent" });
  if (procs.length === 0) return "ERROR: fyagent process not found";
  const proc = procs[0];
  if (proc.windows.length === 0) return "ERROR: no window";
  const win = proc.windows[0];
  const all = win.entireContents();
  const get = (el, f) => {
    try {
      const v = el[f]();
      return v === null || v === undefined ? "" : String(v);
    } catch (e) {
      return "";
    }
  };
  const lines = [];
  for (const el of all) {
    const role = get(el, "role");
    const name = get(el, "name");
    const desc = get(el, "description");
    const title = get(el, "title");
    const value = get(el, "value");
    if (mode === "click") {
      const texts = [name, desc, title, value].map((t) => t.trim());
      if (texts.includes(target)) {
        try {
          el.actions.byName("AXPress").perform();
          return `clicked(AXPress) ${role} "${target}"`;
        } catch (e) {
          try {
            const pos = el.position();
            const size = el.size();
            se.click({ at: [pos[0] + size[0] / 2, pos[1] + size[1] / 2] });
            return `clicked(at) ${role} "${target}"`;
          } catch (e2) {
            return `ERROR: found ${role} "${target}" but click failed: ${e2}`;
          }
        }
      }
    } else if (name || desc || title || value) {
      lines.push([role, name, desc, title, value].map((s) => s.replace(/\s+/g, " ")).join("\t"));
    }
  }
  return mode === "click" ? `NOT FOUND: "${target}"` : lines.join("\n");
}
