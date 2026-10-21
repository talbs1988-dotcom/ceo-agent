// מציאת סוכן לפי מה שבעל העסק או Claude כתבו: מזהה, נתיב לקובץ או לתיקייה, או שם.
// רק התאמות מדויקות. אם יש יותר ממועמד אחד, מחזירים את כולם, והקורא שואל את המשתמש.
import path from "node:path";
import os from "node:os";

const WIN = process.platform === "win32";
const normPath = (p) => {
  let s = String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return WIN ? s.toLowerCase() : s;
};
const normName = (n) =>
  String(n || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function resolveTarget(t) {
  const raw = String(t || "").trim();
  if (/^~(?=[\\/]|$)/.test(raw))
    return path.resolve(raw.replace(/^~/, os.homedir()));
  if (/[\\/]/.test(raw) || raw.startsWith(".")) return path.resolve(raw);
  return raw;
}

export function matchAgents(agents, target) {
  const raw = String(target || "").trim();
  if (!raw) return [];
  const list = agents.filter(
    (a) => !a.gone && a.kind !== "added" && a.kind !== "missing",
  );
  // 1. מזהה מדויק, תווית של משימה, או קישור/מספר של תרחיש Make
  const makeId =
    (raw.match(/scenarios\/(\d+)/) || [])[1] ||
    (/^\d{5,}$/.test(raw) ? raw : null);
  let c = list.filter(
    (a) =>
      a.id === raw ||
      a.id === `launchd:${raw}` ||
      a.id === `task:${raw}` ||
      (makeId && a.id === `make:${makeId}`),
  );
  if (c.length) return c;
  // 2. נתיב: קובץ שהוא באמת חלק מהסוכן, ואם אין, תיקייה שהיא בדיוק התיקייה שלו
  const abs = resolveTarget(raw);
  if (abs !== raw || /[\\/]/.test(raw)) {
    const p = normPath(abs);
    c = list.filter((a) =>
      (a.files || []).some(
        (f) =>
          normPath(f) === p ||
          normPath(f) === `${p}/skill.md` ||
          normPath(f) === `${p}/SKILL.md`,
      ),
    );
    if (c.length) return c;
    c = list.filter((a) => normPath(a.folder) === p);
    return c;
  }
  // 3. שם: השם שמוצג, או השם המקורי (למשל השם בתרחיש Make)
  const n = normName(raw);
  c = list.filter((a) => normName(a.name) === n || (a.sourceName && normName(a.sourceName) === n));
  if (c.length) return c;
  // שם התיקייה של סקיל או צוות (למשל "price-quotes")
  return list.filter((a) => (a.kind === "skill" || a.kind === "team") && a.folder && normName(path.basename(a.folder)) === n);
}
