#!/usr/bin/env node
// סוכן מנכ״ל — הבדיקה הקבועה.
// רצה לבד כל רבע שעה: סורקת ומעדכנת את הדשבורד. אם ההתראות דלוקות ומשהו נכשל או לא רץ בזמן, שולחת הודעה בוואטסאפ.
// על אותה תקלה שולחים פעם אחת. כשהיא נפתרת שולחים "חזר לעבוד".
// אם בעל העסק ביקש, נשלח גם סיכום יומי בשעה שבחר.
//
// שימוש:
//   node alerts/check.mjs            בדיקה רגילה
//   node alerts/check.mjs --test     שולח הודעת בדיקה, כדי לוודא שההתראות מגיעות
//   node alerts/check.mjs --dry      מראה מה היה נשלח, בלי לשלוח

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const HOME = os.homedir();
const TEST = process.argv.includes("--test");
const DRY = process.argv.includes("--dry");
const now = new Date();
const stamp = () => new Date().toLocaleString("he-IL");

const readJSON = (p, f) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return f;
  }
};
const expandHome = (p) =>
  p && p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;

// דוח בריאות של הבדיקה עצמה. נכתב גם כקובץ JS שהדשבורד קורא ישירות, כדי שיראה את המצב העדכני.
function writeHealth(h) {
  if (DRY) return;
  try {
    fs.writeFileSync(path.join(DATA, "alert-health.json"), JSON.stringify(h));
    fs.writeFileSync(path.join(DATA, "alert-health.js"), `window.CEO_ALERT_HEALTH = ${JSON.stringify(h)};\n`);
  } catch {}
}

// קובץ הגדרות שקיים אבל פגום זו תקלה, לא "כבוי": מדווחים, כדי שההתראות לא ייעלמו בשקט
const CONFIG_FILE = path.join(DATA, "config.json");
let config = {};
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    console.error(`[${stamp()}] קובץ ההגדרות data/config.json פגום, ההתראות לא נבדקות`);
    writeHealth({ lastRunAt: new Date().toISOString(), lastError: "קובץ ההגדרות data/config.json פגום, ולכן ההתראות לא נבדקות. צריך לתקן אותו (אפשר לבקש מ-Claude)." });
    process.exit(2);
  }
}
const alerts = config.alerts || {};

// ---------- שליחה ----------
// outbox: העוזר האישי של הסדנה שולח כל קובץ בתיקייה (ומעביר אותו ל-sent כשנשלח).
// command: פקודה מקומית שמקבלת את ההודעה כפרמטר (למשל notify.py קיים).
function send(text) {
  const sender = alerts.sender || {
    type: "outbox",
    dir: "~/talbs-whatsapp-bot/outbox",
  };
  if (DRY) {
    console.log(`--- היה נשלח (${sender.type}) ---\n${text}\n`);
    return true;
  }
  if (
    sender.type === "command" &&
    Array.isArray(sender.cmd) &&
    sender.cmd.length
  ) {
    const [cmd, ...args] = sender.cmd.map(expandHome);
    try {
      execFileSync(cmd, [...args, text], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
      return true;
    } catch (e) {
      console.error(`[${stamp()}] השליחה נכשלה: ${e.message.split("\n")[0]}`);
      return false;
    }
  }
  const dir = expandHome(sender.dir || "~/talbs-whatsapp-bot/outbox");
  if (!fs.existsSync(path.dirname(dir))) {
    console.error(
      `[${stamp()}] העוזר האישי לא מותקן (${path.dirname(dir)}), אין לאן לשלוח`,
    );
    return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  // כותבים לקובץ זמני ומשנים שם, כדי שהעוזר לא יקרא קובץ חצי כתוב
  const file = path.join(dir, `${Date.now()}-ceo-agent.txt`);
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
  return true;
}

if (TEST) {
  const ok = send(
    "🔔 סוכן מנכ״ל: זו הודעת בדיקה. אם היא הגיעה, ההתראות עובדות.",
  );
  console.log(
    ok
      ? (alerts.sender && alerts.sender.type === "command"
        ? "הודעת הבדיקה נשלחה. בודקים בוואטסאפ שהיא הגיעה."
        : "הודעת הבדיקה נשלחה לתור של העוזר. בודקים בוואטסאפ שהיא הגיעה.")
      : "השליחה נכשלה.",
  );
  process.exit(ok ? 0 : 1);
}

// ---------- סריקה ----------
try {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "scan", "scan.mjs"), "--quick"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    },
  );
} catch (e) {
  console.error(`[${stamp()}] הסריקה נכשלה: ${e.message.split("\n")[0]}`);
  process.exit(1);
}
const data = readJSON(path.join(DATA, "agents.json"), null);
if (!data) process.exit(1);

// הבדיקה ברקע מעדכנת את הדשבורד אצל כולם. התראות בוואטסאפ נשלחות רק למי שהדליק אותן.
if (!alerts.enabled) {
  console.log(`[${stamp()}] הדשבורד עודכן. ההתראות כבויות, לא שולחים.`);
  writeHealth({ lastRunAt: new Date().toISOString(), disabled: true, lastError: null });
  process.exit(0);
}

// ---------- מה השתנה ----------
// מפתח לתקלה: רק הסטטוס. שינוי בניסוח הסיבה (למשל "לא מחובר" / "מנסה להתחבר כבר X דקות") הוא לא חדשות.
const keyOf = (a) => String(a.status);
// על אותו סוכן לא שולחים יותר מהודעה אחת ביממה, גם אם הוא מהבהב בין תקין לתקול.
const QUIET = 24 * 60 * 60 * 1000;
const statePath = path.join(DATA, "alert-state.json");
let state = readJSON(statePath, { open: {}, lastDaily: null });
if (!state || typeof state.open !== "object" || !state.open) state = { open: {}, lastDaily: (state && state.lastDaily) || null };
if (!state.lastSent || typeof state.lastSent !== "object") state.lastSent = {};
const quiet = (id) => state.lastSent[id] && now - Date.parse(state.lastSent[id]) < QUIET;
// instant: false = בלי הודעות מיידיות, רק הסיכום היומי
const INSTANT = alerts.instant !== false;
// מה שהמשתמש הוציא מהדשבורד לא שולח התראות
const shown = (a) => a.autonomous && a.shelf !== "drawer" && a.status !== "off";
const bad = (a) => shown(a) && (a.status === "failed" || a.status === "missed" || a.status === "partial");
const byId = Object.fromEntries(data.agents.map((a) => [a.id, a]));
const current = Object.fromEntries(data.agents.filter(bad).map((a) => [a.id, a]));

const fresh = Object.values(current).filter((a) => {
  const prev = state.open[a.id];
  return (!prev || prev.key !== keyOf(a)) && !quiet(a.id);
});
// נפתר = עכשיו תקין, או כבוי/נמחק. "לא ידוע" זה לא נפתר: התקלה נשארת פתוחה ולא נשלחת שוב.
const recovered = Object.keys(state.open)
  .filter((id) => !current[id])
  .filter((id) => !byId[id] || byId[id].shelf === "drawer" || ["ok", "off", "manual"].includes(byId[id].status))
  .map((id) => ({ id, name: state.open[id].name, now: byId[id] }));

const label = { failed: "נכשל", missed: "לא רץ בזמן", partial: "חלקי" };
const lines = [];
if (fresh.length) {
  lines.push(fresh.length === 1 ? "🔔 סוכן מנכ״ל: סוכן אחד צריך אותך" : `🔔 סוכן מנכ״ל: ${fresh.length} סוכנים צריכים אותך`);
  lines.push("");
  for (const a of fresh.slice(0, 8)) lines.push(`• ${a.name} (${label[a.status]}): ${a.statusWhy}`);
  if (fresh.length > 8) lines.push(`• ועוד ${fresh.length - 8}`);
}
// מה שהוצא מהדשבורד נסגר בשקט, בלי הודעת "חזר לעבוד"
const backToWork = recovered.filter((f) => f.now && f.now.status === "ok" && f.now.shelf !== "drawer" && !quiet(f.id));
if (backToWork.length) {
  if (lines.length) lines.push("");
  lines.push(backToWork.length === 1 ? "✅ חזר לעבוד:" : "✅ חזרו לעבוד:");
  for (const f of backToWork.slice(0, 8)) lines.push(`• ${f.name}`);
}

let sentOk = true;
let lastError = null;
if (lines.length && !INSTANT) {
  console.log(`[${stamp()}] ${fresh.length} חדשות, ${backToWork.length} חזרו לעבוד. ההודעות המיידיות כבויות, זה ייכנס לסיכום היומי.`);
} else if (lines.length) {
  lines.push("", "הפרטים בדשבורד של סוכן מנכ״ל.");
  sentOk = send(lines.join("\n"));
  if (!sentOk) lastError = "השליחה לוואטסאפ נכשלה";
  console.log(`[${stamp()}] ${sentOk ? "נשלחה" : "לא נשלחה"} התראה: ${fresh.length} חדשות, ${backToWork.length} חזרו לעבוד`);
} else {
  console.log(`[${stamp()}] אין שינוי. ${Object.keys(current).length} תקלות פתוחות.`);
}

// מעדכנים את מה שדווח רק אם השליחה עברה, כדי שתקלה לא "תיבלע" כשהשליחה נופלת.
if (sentOk) {
  const open = {};
  // תקלות שעדיין פתוחות, כולל כאלה שעברו זמנית ל"לא ידוע"
  for (const [id, prev] of Object.entries(state.open)) {
    if (!current[id] && !recovered.some((r) => r.id === id)) open[id] = prev;
  }
  for (const a of Object.values(current)) {
    const prev = state.open[a.id];
    open[a.id] = { name: a.name, key: keyOf(a), since: (prev && prev.since) || now.toISOString() };
  }
  state.open = open;
  if (INSTANT && lines.length) for (const a of [...fresh, ...backToWork]) state.lastSent[a.id] = now.toISOString();
}

// ---------- סיכום יומי ----------
const today = now.toLocaleDateString("en-CA");
if (alerts.daily && state.lastDaily !== today) {
  const [h, m] = String(alerts.dailyAt || "20:00").split(":").map(Number);
  const due = new Date(now);
  due.setHours(h || 0, m || 0, 0, 0);
  if (now >= due) {
    const autos = data.agents.filter(shown);
    const okN = autos.filter((a) => a.status === "ok").length;
    const idleN = autos.filter((a) => a.status === "idle").length;
    const attention = autos.filter(bad);
    const unknown = autos.filter((a) => a.status === "unknown").length;
    const unchecked = (data.sources || []).filter((s) => !s.checked).map((s) => s.name);
    const msg = [
      "📋 סוכן מנכ״ל: סיכום יומי",
      "",
      `${autos.length} סוכנים רצים לבד. ${okN} רצו ועבדו כמו שצריך.`,
      attention.length ? `צריכים אותך (${attention.length}):` : "אין תקלות ידועות.",
      ...attention.slice(0, 8).map((a) => `• ${a.name}: ${a.statusWhy}`),
      idleN ? `${idleN} לא רצו לאחרונה (מחכים למשהו שיפעיל אותם).` : "",
      unknown ? `${unknown} בלי מספיק מידע כדי לדעת אם עבדו.` : "",
      unchecked.length ? `לא נבדק: ${unchecked.join(", ")}.` : "",
    ]
      .filter((x) => x !== "")
      .join("\n");
    if (send(msg)) state.lastDaily = today;
    else lastError = "הסיכום היומי לא נשלח";
    console.log(`[${stamp()}] סיכום יומי ${state.lastDaily === today ? "נשלח" : "לא נשלח"}`);
  }
}

let queueBlocked = null;
// בשליחה דרך העוזר האישי: ההודעה נכנסת לתור, אבל יוצאת רק אם העוזר מחובר. בודקים את זה.
{
  const sender = alerts.sender || { type: "outbox" };
  if (sender.type !== "command") {
    const st = readJSON(path.join(HOME, "talbs-whatsapp-bot", "status.json"), null);
    const fresh = st && Date.parse(st.updatedAt) > Date.now() - 5 * 60 * 1000;
    // ניתוק קצר (התחברות מחדש של כמה דקות) זה לא תקלה. רק אם זה נמשך יותר מ-5 דקות.
    const ast = readJSON(path.join(DATA, "assistant-state.json"), {});
    const longBad = !ast.badSince || Date.now() - ast.badSince > 5 * 60 * 1000;
    if ((!fresh || !st.connected) && longBad) queueBlocked = "העוזר האישי לא מחובר לוואטסאפ, אז ההודעות מחכות בתור ולא יוצאות";
  }
}

if (!DRY) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  // דוח בריאות של הבדיקה עצמה, כדי שהדשבורד והסורק ידעו אם ההתראות באמת עובדות.
  const prevH = readJSON(path.join(DATA, "alert-health.json"), {});
  writeHealth({
    lastRunAt: new Date().toISOString(),
    lastSendOkAt: lines.length && sentOk ? new Date().toISOString() : prevH.lastSendOkAt || null,
    lastError: lastError || queueBlocked,
    queueBlocked: !!queueBlocked,
    sender: (alerts.sender && alerts.sender.type) || "outbox",
  });
}
if (lastError || queueBlocked) process.exitCode = 2;
