// The shadow cursor's window: transparent, click-through, never focused, hidden unless shown. Shared by the app and the
// live demo (scripts/demo-shadow-cursor.cjs) so both run exactly the same code.

/**
 * @param {{ BrowserWindow: any, webPreferences: () => object, lockDown: (w: any) => void, url: string }} o
 * @returns {{ show(bounds: object): void, send(msg: object): void, hide(): void, destroy(): void }}
 */
function createCursorWindow(o) {
  let win = null;
  let ready = null;
  const alive = () => !!win && !win.isDestroyed();

  function ensure() {
    if (alive()) return ready;
    win = new o.BrowserWindow({
      x: 0, y: 0, width: 800, height: 600,
      transparent: true, frame: false, resizable: false, movable: false, maximizable: false, fullscreenable: false, hasShadow: false,
      focusable: false, skipTaskbar: true, show: false, backgroundColor: "#00000000", title: "Momo cursor", enableLargerThanScreen: true,
      webPreferences: { ...o.webPreferences(), backgroundThrottling: false }, // keep animating even when it has just been shown
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    o.lockDown(win);
    win.on("closed", () => { win = null; ready = null; });
    ready = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
    win.loadURL(o.url);
    return ready;
  }

  // Messages are queued in order behind the page load, so "show" always reaches the page BEFORE the first "move".
  let chain = Promise.resolve();
  const later = (fn) => { chain = chain.then(() => ensure()).then(() => { if (alive()) fn(win); }).catch(() => {}); };

  return {
    show: (bounds) => later((w) => { w.setBounds(bounds); w.showInactive(); }),
    send: (msg) => later((w) => w.webContents.send("momo:cursor", msg)),
    /** put the overlay back on top of every window, including always-on-top ones */
    raise: () => later((w) => { w.setAlwaysOnTop(true, "screen-saver"); w.moveTop(); }),
    hide: () => later((w) => w.hide()),
    /** run a script in the overlay page and return its result (used by the live checks to read where the ghost is) */
    exec: (js) => ensure().then(() => (alive() ? win.webContents.executeJavaScript(js) : null)),
    destroy: () => { if (alive()) win.destroy(); },
  };
}

module.exports = { createCursorWindow };

/**
 * The screen side of the shadow cursor. UI Automation and Win32 report PHYSICAL pixels; the overlay window works in
 * device-independent ones, so positions are converted per display (this is what keeps it right on scaled and multiple screens).
 * @param {any} screen Electron's screen module  @param {any} koffi the Win32 binding
 */
function createCursorScreen(screen, koffi) {
  let getRect = null;
  try {
    const user32 = koffi.load("user32.dll");
    const RECT = koffi.struct("MomoCursorRect", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    getRect = user32.func("bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ MomoCursorRect* rect)");
    void RECT;
  } catch { /* without it, window targets are simply skipped */ }
  return {
    mouse() {
      const p = screen.getCursorScreenPoint();
      const d = screen.getDisplayNearestPoint(p);
      return { bounds: d.bounds, x: p.x - d.bounds.x, y: p.y - d.bounds.y };
    },
    windowRect(hwnd) {
      if (!getRect || !Number.isSafeInteger(hwnd) || hwnd <= 0) return null;
      try {
        const r = {};
        if (!getRect(hwnd, r)) return null;
        return { l: r.left, t: r.top, w: r.right - r.left, h: r.bottom - r.top };
      } catch { return null; }
    },
    locate(px, py, pw, ph) {
      const dip = screen.screenToDipPoint({ x: Math.round(px), y: Math.round(py) });
      const d = screen.getDisplayNearestPoint(dip);
      const k = d.scaleFactor || 1;
      return { bounds: d.bounds, x: dip.x - d.bounds.x, y: dip.y - d.bounds.y, w: pw / k, h: ph / k };
    },
  };
}

module.exports.createCursorScreen = createCursorScreen;
