/**
 * The interview scenarios. Each has two roles; the learner picks either one and Momo's AI plays the other, so the same scene can be
 * practised from both sides. "Objectives" are what a good conversation in that scene needs to accomplish; they steer the AI's
 * questions without being a script, and travel with the session data for whoever evaluates it.
 */
export type ScenarioId = "job" | "restaurant" | "shopping" | "airport" | "classroom" | "social" | "custom";

export interface Role { id: string; label: string }
export interface Scenario {
  id: ScenarioId;
  title: string;
  blurb: string;
  /** where and why the conversation happens (also given to the AI) */
  setting: string;
  roles: [Role, Role];
  objectives: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "job", title: "Job interview", blurb: "An interview for a job at a small company.",
    setting: "A job interview at a small company that is hiring for an entry-level position.",
    roles: [{ id: "applicant", label: "Applicant" }, { id: "interviewer", label: "Interviewer" }],
    objectives: ["Greet and introduce yourself", "Say where you come from and what you study or do", "Describe your skills or experience", "Explain why you want the job", "Ask a question about the job", "Close politely"],
  },
  {
    id: "restaurant", title: "Restaurant", blurb: "Ordering a meal at a restaurant.",
    setting: "A restaurant at lunchtime: the customer arrives, orders food and drink, and pays.",
    roles: [{ id: "customer", label: "Customer" }, { id: "waiter", label: "Waiter" }],
    objectives: ["Greet and ask for a table", "Ask about or choose dishes", "Order food and a drink", "Ask for something you need (water, the bill)", "Thank the waiter and pay"],
  },
  {
    id: "shopping", title: "Shopping", blurb: "Buying something in a shop.",
    setting: "A small shop: the customer is looking for something to buy and asks about it and its price.",
    roles: [{ id: "customer", label: "Customer" }, { id: "shopkeeper", label: "Shopkeeper" }],
    objectives: ["Greet and say what you are looking for", "Ask about colour, size or choice", "Ask the price", "Decide and say what you will buy", "Pay and say goodbye"],
  },
  {
    id: "airport", title: "Airport and travel", blurb: "Travelling: at the airport or asking a local for help.",
    setting: "An airport and the city outside it: a traveller needs check-in help, directions and information.",
    roles: [{ id: "traveller", label: "Traveller" }, { id: "local", label: "Airport staff / local guide" }],
    objectives: ["Greet and explain what you need", "Ask where something is (gate, bus, hotel)", "Understand directions or times", "Say where you are going and for how long", "Thank them"],
  },
  {
    id: "classroom", title: "Classroom", blurb: "A conversation between a student and a teacher.",
    setting: "A language classroom: the student talks with the teacher about the lesson and homework.",
    roles: [{ id: "student", label: "Student" }, { id: "teacher", label: "Teacher" }],
    objectives: ["Greet the teacher", "Say that you understand or do not understand", "Ask for help or a repeat", "Talk about homework or study", "Close politely"],
  },
  {
    id: "social", title: "Everyday conversation", blurb: "Meeting someone and chatting.",
    setting: "Two people meet for the first time and chat about themselves, daily life and interests.",
    roles: [{ id: "friend-a", label: "You" }, { id: "friend-b", label: "New acquaintance" }],
    objectives: ["Greet and introduce yourself", "Ask and answer about each other", "Talk about daily life or hobbies", "Make a simple plan or suggestion", "Say goodbye"],
  },
];

export const CUSTOM_SCENARIO_ID = "custom" as const;

export function scenarioById(id: string): Scenario | undefined { return SCENARIOS.find((s) => s.id === id); }

/** the other role of a two-role scenario */
export function oppositeRole(s: Scenario, userRoleId: string): Role | null {
  const [a, b] = s.roles;
  return userRoleId === a.id ? b : userRoleId === b.id ? a : null;
}

export interface CustomScenarioInput { setting: string; userRole: string; aiRole: string }
const clean = (t: string, n: number) => t.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** a user-written scenario: kept short and plain, because it is given to the AI as data about the scene, never as instructions */
export function customScenario(i: CustomScenarioInput): { ok: true; scenario: Scenario; userRole: Role; aiRole: Role } | { ok: false; reason: string } {
  const setting = clean(i.setting, 240), u = clean(i.userRole, 40), a = clean(i.aiRole, 40);
  if (setting.length < 8) return { ok: false, reason: "Describe the scene in a few words (for example: a visit to the doctor)." };
  if (!u || !a) return { ok: false, reason: "Give a name to both roles." };
  if (u.toLowerCase() === a.toLowerCase()) return { ok: false, reason: "The two roles need different names." };
  const userRole = { id: "user-role", label: u }, aiRole = { id: "ai-role", label: a };
  return { ok: true, userRole, aiRole, scenario: { id: "custom", title: "Custom roleplay", blurb: setting, setting, roles: [userRole, aiRole], objectives: ["Greet and start the conversation", "Say what you need or want in this situation", "Answer the other person's questions", "Ask a question of your own", "Close politely"] } };
}
