#!/usr/bin/env node
// הרשימה של בעל העסק: מה שלו, מה לא שלו, ומה חסר. הרשימה קובעת מה מוצג, והסורק רק מציע.
//   node scan/roster.mjs mine "<מזהה>"          זה שלי (יוצג תמיד, ואם ייעלם נדע)
//   node scan/roster.mjs notmine "<מזהה>"       לא שלי (עובר למגירה)
//   node scan/roster.mjs add "<שם>" "<מה הוא עושה>" [routine] [cloud]   משהו שהסורק לא מצא
//   node scan/roster.mjs remove "<מזהה או שם>"  מוריד מהרשימה
//   node scan/roster.mjs name "<מזהה>" "<שם בעברית>"   שם שמוצג בדשבורד
//   node scan/roster.mjs role "<מזהה>" "<משפט אחד>"    מה הוא עושה
//   node scan/roster.mjs goal "<מזהה>" "<התוצאה שהוא צריך להביא>"
//   node scan/roster.mjs register "<נתיב, מזהה או שם>" "<שם בעברית>" "<מה הוא עושה>" "<התוצאה שהוא צריך להביא>"
//        רישום סוכן חדש בפעולה אחת: סורק, מוצא אותו, מסמן כשלי ושומר שם, תפקיד ותוצאה. Claude מריץ את זה בכל פעם שהוא בונה סוכן.
//   node scan/roster.mjs todo                  הסוכנים שעוד אין להם שם בעברית, תפקיד או תוצאה, עם הקבצים שלהם
//   node scan/roster.mjs describe "<קובץ.json>"   שמירה של הרבה בבת אחת: [{"id","name","role","goal"}]
//   node scan/roster.mjs list
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { matchAgents, resolveTarget } from "./match.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "data", "roster.json");
const [cmd, a1, a2, ...rest] = process.argv.slice(2);
let r = { mine: [], notMine: [], added: [], names: {}, roles: {}, goals: {} };
if (fs.existsSync(FILE)) {
  // רשימה פגומה לא נדרסת: עוצרים, כדי לא לאבד את כל השמות, התפקידים והתוצאות
  try {
    const got = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!got || typeof got !== "object" || Array.isArray(got)) throw new Error();
    r = { ...r, ...got };
    for (const k of ["mine", "notMine", "added"]) if (!Array.isArray(r[k])) throw new Error();
    for (const k of ["names", "roles", "goals"]) if (!r[k] || typeof r[k] !== "object" || Array.isArray(r[k])) throw new Error();
  } catch {
    console.log("הרשימה data/roster.json פגומה, אז לא שיניתי כלום. צריך לתקן אותה קודם (אפשר לבקש מ-Claude).");
    process.exit(1);
  }
}
const save = () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(r, null, 1));
  fs.renameSync(FILE + ".tmp", FILE);
};
const drop = (id) => {
  r.mine = r.mine.filter((x) => x !== id);
  r.notMine = r.notMine.filter((x) => x !== id);
};

const scan = (quick) => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scan", "scan.mjs"), ...(quick ? ["--quick"] : [])], { stdio: "ignore", timeout: 300000 });
  } catch {}
};
const loadAgents = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "agents.json"), "utf8")).agents || [];
  } catch {
    return [];
  }
};
// מזהה קיים? (סוכן שנמצא בסריקה, או משהו שנרשם ידנית)
const known = (id) =>
  loadAgents().some((a) => a.id === id) || r.mine.includes(id) || r.added.some((x) => `added:${x.name}` === id);
const setText = (k, id, v) => ((r[k] = r[k] || {})[id] = v);

if ((cmd === "mine" || cmd === "notmine") && a1) {
  if (!known(a1)) {
    console.log(`לא מצאתי סוכן עם המזהה ${a1}. את המזהה לוקחים מ-data/agents.json (השדה id).`);
    process.exit(1);
  }
  drop(a1);
  if (cmd === "notmine") r.notMine.push(a1);
  else if (!a1.startsWith("added:")) r.mine.push(a1);
  save();
  scan(true);
  console.log(cmd === "mine" ? `סומן כשלך: ${a1}` : `הוצא מהדשבורד (עבר ל"לא בשימוש"): ${a1}`);
} else if (cmd === "add" && a1) {
  r.added = r.added.filter((x) => x.name !== a1);
  r.added.push({
    name: a1,
    role: a2 || "",
    routine: rest.includes("routine"),
    where: rest.includes("cloud") ? "cloud" : "computer",
  });
  save();
  scan(true);
  console.log(`נוסף לרשימה: ${a1}`);
} else if (cmd === "remove" && a1) {
  // מזהה מדויק, או משהו שנרשם ידנית בשם הזה. סוכן אמיתי לפי שם: רק אם יש בדיוק אחד כזה.
  const agents = loadAgents();
  const addedHit = r.added.find((x) => x.name === a1 || `added:${x.name}` === a1 || (r.names || {})[`added:${x.name}`] === a1);
  let ids = [];
  if (agents.some((a) => a.id === a1) || r.mine.includes(a1) || r.notMine.includes(a1)) ids = [a1];
  else if (addedHit) ids = [`added:${addedHit.name}`];
  else {
    const byName = agents.filter((a) => a.name === a1);
    if (byName.length > 1) {
      console.log("יש כמה סוכנים בשם הזה. לא שיניתי כלום. מריצים שוב עם המזהה:");
      for (const a of byName) console.log(`  ${a.id}`);
      process.exit(2);
    }
    ids = byName.map((a) => a.id);
  }
  if (!ids.length) {
    console.log(`לא מצאתי ברשימה את ${a1}.`);
    process.exit(1);
  }
  // סוכן שעדיין קיים במחשב או ב-Make שומר את השם, התפקיד והתוצאה שלו. רק מה שנמחק או נרשם ידנית נמחק לגמרי.
  const alive = new Set(agents.filter((a) => !a.gone && a.kind !== "added").map((a) => a.id));
  for (const id of ids) {
    drop(id);
    if (!alive.has(id)) for (const k of ["names", "roles", "goals"]) if (r[k]) delete r[k][id];
  }
  r.added = r.added.filter((x) => !ids.includes(`added:${x.name}`));
  save();
  scan(true);
  const still = ids.filter((id) => alive.has(id));
  console.log(still.length ? `הוסר מהרשימה: ${a1}. הוא עדיין קיים, אז הוא ימשיך להופיע. להסתיר אותו: notmine.` : `הוסר מהרשימה: ${a1}`);
} else if ((cmd === "name" || cmd === "role" || cmd === "goal") && a1 && a2) {
  if (!known(a1)) {
    console.log(`לא מצאתי סוכן עם המזהה ${a1}.`);
    process.exit(1);
  }
  setText({ name: "names", role: "roles", goal: "goals" }[cmd], a1, a2);
  save();
  scan(true);
  console.log(`עודכן: ${a2}`);
} else if (cmd === "register" && a1) {
  const [name, role, goal] = [a2, rest[0], rest[1]];
  const target = resolveTarget(a1);
  // סקיל: מסמנים אותו כשלי מראש, כדי שהסריקה תציג אותו גם אם הותקן מבחוץ או נבנה הרגע
  let skillId = null;
  try {
    const st = fs.statSync(target);
    const abs = path.resolve(target);
    if (st.isDirectory() && fs.existsSync(path.join(abs, "SKILL.md"))) skillId = `skill:${path.join(abs, "SKILL.md")}`;
    else if (st.isFile() && path.basename(abs) === "SKILL.md") skillId = `skill:${abs}`;
  } catch {}
  if (skillId && !r.mine.includes(skillId)) {
    r.mine.push(skillId);
    save();
  }
  scan(true);
  let hits = matchAgents(loadAgents(), a1);
  if (!hits.length) {
    // סוכן חדש שהסריקה המהירה עוד לא מכירה: סריקה מלאה (לוקחת כדקה)
    console.log("סורק את כל המחשב כדי למצוא אותו, זה לוקח כדקה...");
    scan(false);
    hits = matchAgents(loadAgents(), a1);
  }
  const hit = hits.length === 1 ? hits[0] : null;
  // הסימון המוקדם של הסקיל נשאר רק אם זה באמת הוא
  if (skillId && (!hit || hit.id !== skillId)) {
    r.mine = r.mine.filter((x) => x !== skillId);
    save();
  }
  if (hits.length > 1) {
    console.log("יש כמה סוכנים שמתאימים. לא שמרתי כלום. צריך לבחור אחד ולהריץ שוב עם המזהה שלו:");
    for (const a of hits) console.log(`  ${a.id}  (${a.name})`);
    process.exit(2);
  }
  if (hit && hit.kind === "team" && skillId) {
    // סקיל שהוא חלק מצוות: הצוות מוצג כסוכן אחד, אז לא נותנים לו את השם של חבר בצוות
    drop(hit.id);
    r.mine.push(hit.id);
    save();
    scan(true);
    console.log(`הסקיל הזה הוא חלק מהצוות "${hit.name}" (${hit.id}), שכבר מוצג בדשבורד. לא שיניתי את השם והתפקיד של הצוות. אם צריך, מעדכנים עם name/role/goal על המזהה של הצוות.`);
  } else if (hit) {
    drop(hit.id);
    r.mine.push(hit.id);
    if (name) setText("names", hit.id, name);
    if (role) setText("roles", hit.id, role);
    if (goal) setText("goals", hit.id, goal);
    save();
    scan(true);
    console.log(`נרשם בסוכן מנכ״ל: ${name || hit.name} (${hit.id})`);
  } else {
    // לא נמצא (למשל תרחיש Make שעוד לא נמשך): נרשם ידנית, ומתחבר לבד כשהסריקה תמצא אותו
    const n = name || a1;
    const cloud = rest.includes("cloud") || /make\.com|scenarios\//i.test(a1);
    r.added = r.added.filter((x) => x.name !== n);
    r.added.push({ name: n, role: role || "", goal: goal || "", routine: rest.includes("routine"), where: cloud ? "cloud" : "computer", target: resolveTarget(a1) });
    save();
    scan(true);
    console.log(`לא מצאתי אותו במחשב או ב-Make, אז הוא נרשם ידנית: ${n}. כשהסריקה תמצא אותו, הוא יתחבר לבד.`);
  }
} else if (cmd === "todo") {
  if (!fs.existsSync(path.join(ROOT, "data", "agents.json"))) {
    console.log("אין עדיין סריקה. מריצים קודם scan.mjs");
    process.exit(1);
  }
  const agents = loadAgents();
  const list = agents
    .filter((a) => a.needsDefinition)
    .map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role || a.description || "",
      goal: a.goal || "",
      when: a.schedule,
      where: a.where,
      outputs: (a.outputs || []).map((o) => o.label),
      files: a.files || [],
      folder: a.folder || "",
    }));
  console.log(JSON.stringify(list, null, 1));
  console.error(`${list.length} סוכנים צריכים שם, תפקיד או תוצאה.`);
} else if (cmd === "describe" && a1) {
  const items = JSON.parse(fs.readFileSync(a1, "utf8"));
  const ids = new Set(loadAgents().filter((a) => !a.gone).map((a) => a.id));
  let n = 0;
  const skipped = [];
  for (const x of Array.isArray(items) ? items : []) {
    if (!x || !x.id) continue;
    if (!ids.has(x.id)) {
      skipped.push(x.id);
      continue;
    }
    if (x.name) setText("names", x.id, x.name);
    if (x.role) setText("roles", x.id, x.role);
    if (x.goal) setText("goals", x.id, x.goal);
    if (x.mine !== false && !x.id.startsWith("added:") && !r.notMine.includes(x.id) && !r.mine.includes(x.id)) r.mine.push(x.id);
    n++;
  }
  save();
  scan(true);
  console.log(`נשמרו ${n} סוכנים.`);
  if (skipped.length) console.log(`לא נמצאו ולא נשמרו: ${skipped.join(", ")}`);
} else if (cmd === "list") {
  console.log(JSON.stringify(r, null, 1));
} else {
  console.log(
    "שימוש: register <נתיב|מזהה|שם> <שם> <תפקיד> <תוצאה> | todo | describe <קובץ> | mine <מזהה> | notmine <מזהה> | add <שם> <תפקיד> [routine] [cloud] | remove <מזהה או שם> | name|role|goal <מזהה> <טקסט> | list",
  );
  process.exit(1);
}
