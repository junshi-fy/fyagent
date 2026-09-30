// JXA helper (osascript -l JavaScript) for the macOS smoke VM. Reads and clicks
// the FyAgent window through the Accessibility tree (WKWebView content is
// exposed as AX elements).
//   dump                         -> role/name/desc/title/value lines
//   click <text>                 -> press the first button/link whose label is <text>
//   clickafter <anchor> <text>   -> press the first <text> button after the element labelled <anchor>
function run(argv) {
  const norm = (s) => String(s || "").normalize("NFC").replace(/\s+/g, " ").trim();
  const mode = argv[0] || "dump";
  const a1 = norm(argv[1]);
  const a2 = norm(argv[2]);
  const se = Application("System Events");
  const procs = se.processes.whose({ name: "fyagent" });
  if (procs.length === 0) return "ERROR: fyagent process not found";
  const proc = procs[0];
  const wins = proc.windows();
  if (!wins.length) return "ERROR: no window";
  const get = (el, f) => {
    try { return norm(el[f]()); } catch (e) { return ""; }
  };
  const press = (el, role, label) => {
    try {
      el.actions.byName("AXPress").perform();
      return `clicked(AXPress) ${role} "${label}"`;
    } catch (e) {
      try {
        const pos = el.position();
        const size = el.size();
        se.click({ at: [pos[0] + size[0] / 2, pos[1] + size[1] / 2] });
        return `clicked(at) ${role} "${label}"`;
      } catch (e2) {
        return `ERROR: click failed on ${role} "${label}": ${e2}`;
      }
    }
  };
  const lines = [];
  let seenAnchor = false;
  let count = 0;
  for (const win of wins) {
    const all = win.entireContents();
    for (const el of all) {
      count += 1;
      const role = get(el, "role");
      const texts = [get(el, "name"), get(el, "description"), get(el, "title"), get(el, "value")];
      const clickable = role === "AXButton" || role === "AXLink" || role === "AXMenuItem";
      // Onboarding choices expose "编程开发 写代码、修问题与测试" as one label.
      const matches = (want) => texts.some((t) => t === want || t.startsWith(`${want} `));
      if (mode === "click") {
        if (clickable && matches(a1)) return press(el, role, a1);
      } else if (mode === "clickafter") {
        // Scope to the anchor's card: stop at the next product heading so a
        // card without the button never borrows the next card's button.
        if (!seenAnchor && role === "AXHeading" && texts.includes(a1)) seenAnchor = true;
        else if (seenAnchor && role === "AXHeading" && texts.some((t) => t)) return `NO BUTTON (card "${a1}" has no "${a2}"; next heading ${texts.find((t) => t)})`;
        else if (seenAnchor && clickable && texts.includes(a2)) return press(el, role, `${a1} > ${a2}`);
      } else if (texts.some((t) => t)) {
        lines.push([role, ...texts].join("\t"));
      }
    }
  }
  if (mode === "dump") return lines.join("\n");
  return `NOT FOUND (${mode} "${a1}" "${a2}", anchorSeen=${seenAnchor}, elements=${count}, windows=${wins.length})`;
}
