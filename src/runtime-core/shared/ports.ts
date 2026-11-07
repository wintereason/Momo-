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
}
export type UiReadResult = { ok: true; items: UiNode[]; truncated: boolean; hadPasswordField?: boolean } | { ok: false; reason: string };
export type OcrResult = { ok: true; lines: string[] } | { ok: false; reason: string };

/** Looking at one specific window. Pixels are captured and recognised in memory only. */
export interface ScreenPort {
  readUi(hwnd: number): Promise<UiReadResult>;
  ocr(hwnd: number): Promise<OcrResult>;
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
}

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
}
export interface WindowsSnapshot {
  /** pid of the foreground window's process, or null if unknown */
  activePid: number | null;
  /** the foreground window itself, when known: lets a program with several windows be told apart */
  activeHwnd?: number | null;
  windows: RawWindow[];
}
export interface WindowsPort {
  query(): Promise<WindowsSnapshot>;
}
