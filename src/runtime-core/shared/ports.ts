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
export type UiReadResult = { ok: true; items: UiNode[]; truncated: boolean; hadPasswordField?: boolean; /** a password field has the keyboard focus right now: no key may be pressed */ passwordFocused?: boolean } | { ok: false; reason: string };
export type OcrWordsResult = { ok: true; words: Array<{ text: string; rect: { l: number; t: number; w: number; h: number } }> } | { ok: false; reason: string };
export type OcrResult = { ok: true; lines: string[] } | { ok: false; reason: string };
/** The control under a point and its parents: runtime id, type, name, and whether it is a password field. In memory only. */
export type ElementAtResult = { ok: true; /** the top-level window the point is in (0 when unknown) */ root?: number; chain: Array<{ rid: string; type: string; name: string; password: boolean }> } | { ok: false; reason: string };
export type TransientKind = "menu" | "dialog" | "dropdown" | "popup" | "window" | "secure" | "other";
/** A window the normal list does not show. Handles, class and geometry only: never a title or text. */
export interface TransientWindow {
  hwnd: number; pid: number; proc: string; cls: string; kind: TransientKind;
  owner: number; rootOwner: number; top: boolean; tool: boolean; fg: boolean;
  rect: { l: number; t: number; w: number; h: number };
}
export type TransientsResult = { ok: true; windows: TransientWindow[] } | { ok: false; reason: string };
/** One item of a menu. `depth`/`parent` give the hierarchy inside one popup (parent is an index into the same list, -1 at the top). */
export interface MenuEntry {
  name: string; enabled: boolean; offscreen: boolean; focused: boolean; separator: boolean; expandable: boolean;
  checked: "on" | "off" | ""; shortcut: string; rid: string; rect?: { l: number; t: number; w: number; h: number }; depth: number; parent: number;
}
export type MenuResult = { ok: true; items: MenuEntry[] } | { ok: false; reason: string };
/** A picture of a small part of one window, in memory only (never written to disk). */
export type CaptureResult = { ok: true; png: string; width: number; height: number } | { ok: false; reason: string };

/** Looking at one specific window. Pixels are captured and recognised in memory only. */
export interface ScreenPort {
  readUi(hwnd: number): Promise<UiReadResult>;
  ocr(hwnd: number): Promise<OcrResult>;
  /** read the text inside ONE box of a window (screen pixels): the text of an icon, or of the label next to it. Absent in simple fakes. */
  /** the words on a window with where each one is on screen (physical pixels), from the same local OCR. Used only when UI Automation cannot name a control. */
  ocrWords?(hwnd: number): Promise<OcrWordsResult>;
  /** what is under one point of the screen right now, and its parents (innermost first): used to check a target just before a real click. Absent in simple fakes. */
  elementAt?(x: number, y: number): Promise<ElementAtResult>;
  /** the visible menus, dialogs, dropdowns and popups (the windows the normal window list skips), optionally only those that belong to one window. Facts only: no titles. Absent in simple fakes. */
  transients?(owner?: number): Promise<TransientsResult>;
  /** the menu items inside one popup window, with their hierarchy and state */
  readMenu?(hwnd: number): Promise<MenuResult>;
  /** the current text of ONE field (to check what was typed into it): never a password field; the caller compares it and keeps nothing */
  fieldValue?(hwnd: number, rid: string): Promise<{ ok: true; value: string } | { ok: false; reason: string }>;
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
  /** Windows says the application has stopped responding (it will not take input now). Absent = not known (the one-shot fallback cannot tell). */
  hung?: boolean;
  /** the window has an enabled dialog of its own open on top of it (GW_ENABLEDPOPUP): it is waiting for an answer there. Absent = not known. */
  modal?: boolean;
}

/** Where a real pointer click would land, and whether the user took the mouse back while it travelled. */
/** Did a step's input reach the application? "no" nothing was sent; "maybe" it was being sent when it failed (or it is not known); "yes" it was delivered. */
export type Acted = "no" | "maybe" | "yes";
export type PointerResult = { ok: true } | { ok: false; reason: "user_moved" | "covered" | "failed" | "stopped" | "moved" | "gone" | "changed" | "password" | "offscreen" | "cursor_refused" | "focus_changed" | "cancelled" };
/** The caller's last check of the TARGET, asked about the exact point a button is about to go down on. A check that fails (or cannot run) means: no press. */
export type TargetCheck = (pt: { x: number; y: number }) => Promise<{ ok: true } | { ok: false; reason: string }>;
/**
 * The REAL mouse and keyboard, used to act the way a person does (the human-like mode in Settings). It is only ever used on a
 * target that was identified first, and it gives up the moment the user touches the mouse or presses Esc.
 */
export interface PointerPort {
  /**
   * Glide the real pointer to a screen point over `ms`, then press the button. `expectRoot` is the window that must be under the
   * pointer when it arrives (a covered target is refused, never clicked blindly).
   */
  click(x: number, y: number, opts: { ms: number; /** the window must be exactly here (as it was when read): refused with "moved" if it was dragged since */ expectWindow?: { hwnd: number; rect: { l: number; t: number; w: number; h: number } }; expectRoot?: number | number[]; /** window class names that may be under the pointer (the taskbar's, for a taskbar button) */ expectClass?: string[]; double?: boolean; /** default "left" */ button?: "left" | "right"; /** asked just before the press: is what is under the pointer still the control that was meant? */ verifyTarget?: TargetCheck }): Promise<PointerResult>;
  /** Drag with the left button held from one point to another (the button is always let go again). Only the start is guarded; `dropRoot` optionally requires a window under the drop point. */
  drag?(from: { x: number; y: number }, to: { x: number; y: number }, opts: { ms?: number; expectRoot?: number | number[]; expectWindow?: { hwnd: number; rect: { l: number; t: number; w: number; h: number } }; dropRoot?: number; /** the window the item is dropped into must still exist */ dropWindow?: number; /** checked at the start (is that still the item?) and just before the drop (is that still the place?) */ verifySource?: TargetCheck; verifyDrop?: TargetCheck }): Promise<PointerResult>;
  /** Scroll the wheel at a point: positive = down, negative = up, in notches. */
  scroll?(x: number, y: number, notches: number, opts: { ms?: number; expectRoot?: number | number[]; expectWindow?: { hwnd: number; rect: { l: number; t: number; w: number; h: number } } }): Promise<PointerResult>;
  /** Press keys as a person would, e.g. "enter", "ctrl+a". Goes to whatever window is in front. */
  press(keys: string, opts?: { /** the window that must have the keyboard focus: nothing is sent if another one has it */ expectForeground?: number | number[] }): Promise<PointerResult>;
  /** Type text letter by letter (Unicode), into whatever has the keyboard focus. */
  type(text: string, perKeyMs?: number, opts?: { /** typing stops (with "focus_changed") the moment another window takes the keyboard, and with "gone" if the window closes */ expectForeground?: number | number[]; expectWindow?: number }): Promise<PointerResult>;
  /** The top-level window under a screen point (0 when none). */
  windowAt(x: number, y: number): number;
  /** Where a window is on screen right now, in physical pixels (null when it is gone). */
  windowRect?(hwnd: number): { l: number; t: number; w: number; h: number } | null;
  /** "mouse" / "esc" if the user took over during this task (everything stops), else null. */
  interrupted?(): "mouse" | "esc" | null;
  /** Cancel / quit: stop at once and let go of anything held (a drag is cancelled, not dropped) */
  abort?(why?: "cancel" | "quit"): void;
  /** let go of every button and key Momo is holding (a no-op when none is) */
  releaseAll?(): number;
  /** how many buttons and keys Momo is holding right now */
  heldCount?(): number;
  /** forget what input has been sent so far (a new step begins) */
  resetActed?(): void;
  /** the strongest answer since resetActed(): did any button, key, wheel or typed character reach the app? */
  actedSince?(): Acted;
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
