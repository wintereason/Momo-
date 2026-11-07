# Open Decisions (AI tool: recommend, explain trade-offs, then wait for approval)

1. **Desktop shell:** Tauri vs Electron (or other). Consider: always-on-top transparent frameless window, global shortcuts with key-up detection, bundle size, Windows UI Automation access, audio capture.
2. **Frontend stack:** framework + language (TypeScript expected). Rendering approach for the character: 2D sprites in DOM/canvas now, Three.js/WebGL later for `.glb`.
3. **Runtime/backend language:** the part that does Windows APIs, UI Automation, filesystem, audio. (e.g. Rust, C#/.NET, Python, Node) Consider Windows API support and maintainability.
4. **Speech-to-text:** cloud vs local model; privacy disclosure; latency.
5. **LLM provider(s) for the orchestrator:** behind a provider adapter. Include local-only mode option.
6. **Global shortcut in hold mode:** reliable key-up detection on Windows, conflict handling.
7. **Missing expressions:** the sheet lacks some states for some characters (see manifest). Use fallbacks or generate more art?
8. **Sprite cut-outs:** user supplies transparent PNGs; until then use placeholders.
9. **IP note:** Gojo, Nezuko, Megumi are existing anime characters. Fine for personal use; replace with original characters before any public release or sale. Keep names as config labels so this swap is trivial.
10. **Target:** Windows 11 first. Minimum laptop spec for performance budget?
