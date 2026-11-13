/** Narrow interfaces to the operating system. Real versions live in nodePorts.ts; tests use fakes. */

export interface FsPort {
  /** Existing drive roots, e.g. ["C:\\", "D:\\"] */
  listDriveRoots(): Promise<string[]>;
  statfs(root: string): Promise<{ total: number; free: number }>;
  /** Names of the sub-directories of a path, or null if it can't be read. */
  readDirs(path: string): Promise<string[] | null>;
  /** Files and sub-directories of a path (symlinks and junctions are not followed), or null if it can't be read. Absent in simple fakes. */
  readEntries?(path: string): Promise<{ name: string; isDir: boolean }[] | null>;
  stat(path: string): Promise<{ isDir: boolean } | null>;
  homeDir(): string;
}

/** One control found by UI Automation. */
export interface UiNode {
  /** Button, Edit, Text, Document, ListItem, ... */
  type: string;
  name: string;
  enabled: boolean;
  offscreen: boolean;
  /** current text of an edit box (never set for password fields) */
  value?: string;
  /** the control holds a password: it must never be read or reported */
  password?: boolean;
  /** UI Automation runtime id: identifies THIS control while it exists (used to re-find it before acting) */
  rid?: string;
  /** "on" / "off" for checkboxes and radio buttons, "selected" / "unselected" for tabs */
  state?: string;
  /** an edit box that cannot be typed into */
  readOnly?: boolean;
  /** where the control is on screen, in physical pixels (used only to show the shadow cursor, never to click) */
  rect?: { l: number; t: number; w: number; h: number };
  /** this control has the keyboard focus right now */
  focused?: boolean;
  /** the nearest named panel it sits in (a toolbar, a sidebar, the page): tells look-alike controls apart */
  panel?: string;
  /** what the application itself says about this control (UI Automation metadata): the first thing to trust */
  autoId?: string;
  className?: string;
  /** the tooltip / help text the app attached to it */
  help?: string;
  /** the name of the label element the app tied to this field */
  labelledBy?: string;
  /** what it can do, as UI Automation patterns: "invoke", "value", "toggle", "expandcollapse", "selectionitem", ... */
  patterns?: string[];
  /** a menu/dropdown/tree node: "expanded" or "collapsed" */
  expanded?: string;
}
export type UiReadResult = { ok: true; items: UiNode[]; truncated: boolean; hadPasswordField?: boolean } | { ok: false; reason: string };
export type OcrResult = { ok: true; lines: string[] } | { ok: false; reason: string };
/** A picture of a small part of one window, in memory only (never written to disk). */
export type CaptureResult = { ok: true; png: string; width: number; height: number } | { ok: false; reason: string };

/** Looking at one specific window. Pixels are captured and recognised in memory only. */
export interface ScreenPort {
  readUi(hwnd: number): Promise<UiReadResult>;
  ocr(hwnd: number): Promise<OcrResult>;
  /** read the text inside ONE box of a window (screen pixels): the text of an icon, or of the label next to it. Absent in simple fakes. */
  ocrRegion?(hwnd: number, rect: { l: number; t: number; w: number; h: number }): Promise<OcrResult>;
  /** a PNG (base64) of one box of a window, for a visual AI to look at. Only ever sent anywhere after the user agrees. */
  capture?(hwnd: number, rect: { l: number; t: number; w: number; h: number }): Promise<CaptureResult>;
  /** the taskbar's buttons (Start, pinned and running apps) with their on-screen boxes: where a person would click to open an app */
  taskbar?(): Promise<UiNode[] | null>;
}

export type ActResult = { ok: true } | { ok: false; reason: string };
export type SetTextResult = { ok: true; readBack: string } | { ok: false; reason: string };
export interface WindowState {
  exists: boolean;
  minimized: boolean;
  /** pid of the window's own process */
  pid: number;
  /** pid of whichever window is in front right now */
  foregroundPid: number | null;
  /** the window fills the screen (absent in simple fakes) */
  maximized?: boolean;
}

/** Where a real pointer click would land, and whether the user took the mouse back while it travelled. */
export type PointerResult = { ok: true } | { ok: false; reason: "user_moved" | "covered" | "failed" | "stopped" | "moved" };
/**
 * The REAL mouse and keyboard, used to act the way a person does (the human-like mode in Settings). It is only ever used on a
 * target that was identified first, and it gives up the moment the user touches the mouse or presses Esc.
 */
export interface PointerPort {
  /**
   * Glide the real pointer to a screen point over `ms`, then press the button. `expectRoot` is the window that must be under the
   * pointer when it arrives (a covered target is refused, never clicked blindly).
   */
  click(x: number, y: number, opts: { ms: number; /** the window must be exactly here (as it was when read): refused with "moved" if it was dragged since */ expectWindow?: { hwnd: number; rect: { l: number; t: number; w: number; h: number } }; expectRoot?: number; /** window class names that may be under the pointer (the taskbar's, for a taskbar button) */ expectClass?: string[]; double?: boolean }): Promise<PointerResult>;
  /** Press keys as a person would, e.g. "enter", "ctrl+a". Goes to whatever window is in front. */
  press(keys: string): Promise<PointerResult>;
  /** Type text letter by letter (Unicode), into whatever has the keyboard focus. */
  type(text: string, perKeyMs?: number): Promise<PointerResult>;
  /** The top-level window under a screen point (0 when none). */
  windowAt(x: number, y: number): number;
  /** Where a window is on screen right now, in physical pixels (null when it is gone). */
  windowRect?(hwnd: number): { l: number; t: number; w: number; h: number } | null;
  /** "mouse" / "esc" if the user took over during this task (everything stops), else null. */
  interrupted?(): "mouse" | "esc" | null;
}

/**
 * Acting on windows and controls. Every call targets one identified window (and, for controls, one
 * control by runtime id) and refuses if what it finds no longer matches what was approved.
 */
export interface InputPort {
  focusWindow(hwnd: number): Promise<ActResult>;
  minimizeWindow(hwnd: number): Promise<ActResult>;
  /** asks the window to close normally (like clicking its X): it may still prompt to save */
  closeWindow(hwnd: number): Promise<ActResult>;
  windowState(hwnd: number): Promise<WindowState>;
  /** click via UI Automation. `expectName` guards against the control having changed since it was found. */
  invokeControl(hwnd: number, rid: string, expectName: string): Promise<ActResult>;
  setControlText(hwnd: number, rid: string, expectName: string, text: string): Promise<SetTextResult>;
  /** put the keyboard focus in this exact field (re-checked first: name, enabled, visible, not a password box) */
  focusControl?(hwnd: number, rid: string, expectName: string): Promise<ActResult>;
  /** press Enter in the field that has the focus (only if it is exactly this one) and report whether anything changed */
  submitControl?(hwnd: number, rid: string, expectName: string): Promise<SubmitResult>;
}
export type SubmitResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/** One installed application, as the Start menu knows it. */
export interface AppEntry {
  name: string;
  /** Start-menu application id: the only thing Momo ever launches an app by */
  id: string;
}
export interface AppsPort {
  /** Installed apps (classic and Store apps) */
  list(): Promise<AppEntry[]>;
}
/** Starting programs. Targets always come from the OS app index or a verified folder/URL, never from raw speech. */
export type BrowserKey = "chrome" | "msedge" | "brave";
/** One browser profile (one signed-in account or persona). */
export interface BrowserProfile {
  dir: string;
  name: string;
  email?: string;
  /** the built-in picture the user chose for this profile, e.g. "panda" (only when one was deliberately chosen) */
  avatar?: string;
}

export interface LaunchPort {
  launchApp(id: string): Promise<ActResult>;
  /** the profiles of a Chromium browser, read from its own settings file (absent in tests and non-Windows builds) */
  browserProfiles?(browser: BrowserKey): Promise<BrowserProfile[]>;
  /** open the browser with one specific profile (or its last-used one when profileDir is null), optionally at a web address */
  openBrowserProfile?(browser: BrowserKey, profileDir: string | null, url?: string): Promise<ActResult>;
  /** open a folder in Visual Studio Code (an application adapter) */
  openFolderInVsCode(folder: string): Promise<ActResult>;
  /** open an http(s) address in the user's default browser */
  openUrl(url: string): Promise<ActResult>;
}

/** Which window the user was in before they turned to Momo. */
export interface ForegroundPort {
  lastExternal(): { hwnd: number; pid: number; title: string } | null;
}

/** Things Momo can do to the PC. Provided by the host app (Electron), never by the UI. */
export interface ActionPort {
  /** Opens a folder in the default file manager. Resolves to "" on success or an error message. */
  openPath(path: string): Promise<string>;
}

export interface RawWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  /** shown only as a taskbar button (absent in simple fakes) */
  minimized?: boolean;
  maximized?: boolean;
  /** 0 = the window on top; larger = further back */
  z?: number;
}
export interface WindowsSnapshot {
  /** names of every running program (lower case), windows or not: an app in the tray has a process but no window */
  processes?: string[];
  /** pid of the foreground window's process, or null if unknown */
  activePid: number | null;
  /** the foreground window itself, when known: lets a program with several windows be told apart */
  activeHwnd?: number | null;
  windows: RawWindow[];
}
export interface WindowsPort {
  query(): Promise<WindowsSnapshot>;
}
