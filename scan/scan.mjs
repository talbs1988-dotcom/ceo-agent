#!/usr/bin/env node
// סוכן מנכ״ל — הסורק.
// אוסף את כל הסוכנים במחשב (משימות מתוזמנות, סקילים, העוזר האישי, תרחישי Make)
// וכותב את data/agents.js שהדשבורד קורא.
// כלל ברזל: כל סטטוס נגזר מהוכחה. אין הוכחה = "לא ידוע", אף פעם לא ירוק כברירת מחדל.
// הסורק לא שומר תוכן של קבצים — רק שם, נתיב, לוח זמנים, סטטוס ומשפט תיאור.
//
// שימוש:
//   node scan/scan.mjs            סריקה מלאה (כולל חיפוש השיחות שבהן נבנה כל סוכן)
//   node scan/scan.mjs --quick    בלי חיפוש בשיחות (לבדיקה המתוזמנת)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchAgents } from "./match.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const HOME = os.homedir();
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const QUICK = process.argv.includes("--quick");
const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

fs.mkdirSync(DATA, { recursive: true });

// ---------- כלים קטנים ----------

const readJSON = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};
const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
      ...opts,
    });
  } catch {
    return null;
  }
};
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (h, m) => `${pad(h ?? 0)}:${pad(m ?? 0)}`;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// מסיר כל מה שנראה כמו מפתח, טוקן או סיסמה, למקרה שהגיע בטעות לתיאור.
const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,}|[A-Za-z0-9_-]{32,}|(?:key|token|secret|password|apikey|api_key)\s*[:=]\s*\S+)/gi;
const clean = (s, max = 220) => {
  if (!s) return "";
  let t = String(s).replace(SECRET_RE, "•••").replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
};

// ---------- 1. אינדקס שיחות: איזו שיחה כתבה כל קובץ ----------
// כל שיחה ב-Claude Code נשמרת כקובץ jsonl. מחפשים בה כתיבות קבצים (Write/Edit),
// ושומרים לכל קובץ את השיחה האחרונה שכתבה אותו. האינדקס מתעדכן רק לקבצים שהשתנו.

function buildSessionIndex() {
  const cachePath = path.join(DATA, "sessions-index.json");
  const cache = readJSON(cachePath, { v: 3, files: {}, writes: {}, usage: {} });
  if (cache.v !== 3) {
    cache.v = 3;
    cache.files = {};
    cache.writes = {};
    cache.usage = {};
  }
  const projectsDir = path.join(HOME, ".claude", "projects");
  if (!exists(projectsDir)) return cache.writes;

  const WRITE_RE =
    /"name":"(?:Write|Edit|MultiEdit|NotebookEdit)","input":\{"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)+)"/g;
  const CWD_RE = /"cwd":"((?:[^"\\]|\\.)+)"/;
  const TS_RE = /"timestamp":"([^"]+)"/;

  for (const proj of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, proj);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const seen = cache.files[p];
      if (seen && seen.m === st.mtimeMs && seen.s === st.size) continue;
      cache.files[p] = { m: st.mtimeMs, s: st.size };
      let text;
      try {
        text = fs.readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const cwdM = text.match(CWD_RE);
      const cwd = cwdM ? JSON.parse(`"${cwdM[1]}"`) : null;
      // שימוש בסקילים: באילו ימים הופעל כל סקיל בשיחה הזו (כלי Skill, או פקודה עם /).
      const used = {};
      for (const line of text.split("\n")) {
        if (!line.includes('"Skill"') && !line.includes("command-name")) continue;
        const ts = (line.match(TS_RE) || [])[1];
        const day = ts ? ts.slice(0, 10) : null;
        if (!day) continue;
        for (const mm of line.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"|<command-name>\/?([^<]+)<\/command-name>/g)) {
          const name = (mm[1] || mm[2] || "").trim();
          if (!name) continue;
          (used[name] = used[name] || new Set()).add(day);
        }
      }
      cache.usage[p] = { cwd, m: st.mtimeMs, skills: Object.fromEntries(Object.entries(used).map(([k, v]) => [k, [...v]])) };
      if (!text.includes('"file_path"') && !text.includes('"notebook_path"'))
        continue;
      const session = f.replace(/\.jsonl$/, "");
      const tsM = text.match(TS_RE);
      const at = st.mtimeMs || (tsM ? Date.parse(tsM[1]) : 0);
      let m;
      WRITE_RE.lastIndex = 0;
      while ((m = WRITE_RE.exec(text))) {
        let fp;
        try {
          fp = JSON.parse(`"${m[1]}"`);
        } catch {
          continue;
        }
        const prev = cache.writes[fp];
        if (!prev || prev.at < at) cache.writes[fp] = { session, cwd, at };
      }
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cache.writes;
}

// כמה ימים שונים כל סקיל הופעל, מתוך השיחות שעדיין קיימות במחשב (בלי תיקיות זמניות וניסיונות).
const TEMP_CWD = /^\/(private\/)?tmp\/|scratchpad|[\\/](test|tests|ניסיון|ניסוי|tmp)[\\/]?$/i;
function skillUsage() {
  const cache = readJSON(path.join(DATA, "sessions-index.json"), null);
  if (!cache || !cache.usage) return { window: 0, by: {} };
  let oldest = NOW;
  const by = {};
  for (const u of Object.values(cache.usage)) {
    if (u.m && u.m < oldest) oldest = u.m;
    if (u.cwd && TEMP_CWD.test(u.cwd)) continue;
    for (const [name, days] of Object.entries(u.skills || {})) {
      const short = name.replace(/^[^:]+:/, "");
      for (const key of new Set([name, short])) {
        const b = (by[key] = by[key] || { days: new Set(), last: null });
        for (const d of days) {
          if (Date.parse(d) < NOW - 60 * DAY) continue;
          b.days.add(d);
          if (!b.last || d > b.last) b.last = d;
        }
      }
    }
  }
  const window = Math.min(60, Math.max(1, Math.round((NOW - oldest) / DAY)));
  const out = {};
  for (const [k, v] of Object.entries(by)) out[k] = { days: v.days.size, last: v.last };
  return { window, by: out };
}

// ---------- 2. סקילים ----------

function parseFrontmatter(text) {
  text = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === "" && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]))
        items.push(lines[++i].replace(/^\s*-\s+/, "").trim());
      out[kv[1]] = items;
      continue;
    }
    if (val === "|" || val === ">" || val === ">-" || val === "|-") {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]))
        block.push(lines[++i].trim());
      val = block.join(" ");
    }
    out[kv[1]] = val.replace(/^["']|["']$/g, "");
  }
  return out;
}

// משפט אחד מתוך התיאור: עד הנקודה או המקף הראשון, בלי רשימת מילות ההפעלה.
const firstSentence = (s) => {
  if (!s) return "";
  const cut = s.split(
    /(?<=[.!?])\s|\s—\s|Use when|Triggers|להפעיל כש|השתמש בסקיל/,
  )[0];
  return clean(cut, 160);
};

function readSkill(dir, scope, projectDir) {
  const file = path.join(dir, "SKILL.md");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  return {
    name: fm.name || path.basename(dir),
    description: firstSentence(fm.description || ""),
    descriptionFull: clean(fm.description || "", 600),
    path: file,
    dir,
    scope,
    projectDir,
    isLink: (() => {
      try {
        return fs.lstatSync(dir).isSymbolicLink();
      } catch {
        return false;
      }
    })(),
    text,
  };
}

// תיקיות שלא סורקים: מערכת, גיבויים, ספריות קוד.
const SKIP_DIRS = new Set([
  "node_modules",
  "Library",
  ".Trash",
  ".git",
  "AppData",
  ".cache",
  ".npm",
  ".nvm",
  ".vscode",
  ".cursor",
  "Applications",
  "Pictures",
  "Music",
  "Movies",
]);
const SKIP_NAMES = /גיבוי|backup|\.hyperframes-studio/i;

function findProjectSkillDirs(base, depth) {
  const found = [];
  const walk = (dir, d) => {
    if (d > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name) || SKIP_NAMES.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name === ".claude") {
        const sk = path.join(full, "skills");
        if (full !== path.join(HOME, ".claude") && exists(sk))
          found.push({ skillsDir: sk, projectDir: dir });
        continue;
      }
      if (e.name.startsWith(".")) continue;
      walk(full, d + 1);
    }
  };
  walk(base, 0);
  return found;
}

function scanSkills(writes) {
  const skills = [];
  const globalDir = path.join(HOME, ".claude", "skills");
  if (exists(globalDir)) {
    for (const n of fs.readdirSync(globalDir)) {
      let s = null;
      try { s = readSkill(path.join(globalDir, n), "global", null); } catch {}
      if (s) skills.push(s);
    }
  }
  for (const { skillsDir, projectDir } of findProjectSkillDirs(HOME, 4)) {
    let names = [];
    try {
      names = fs.readdirSync(skillsDir);
    } catch {
      continue;
    }
    for (const n of names) {
      let s = null;
      try { s = readSkill(path.join(skillsDir, n), "project", projectDir); } catch {}
      if (s) skills.push(s);
    }
  }
  for (const s of skills) {
    const w = writes[s.path];
    s.session = w ? w.session : null;
    s.sessionCwd = w ? w.cwd : null;
    // "נבנה על ידך": סקיל בתיקיית עבודה, או סקיל ששיחה שלך כתבה. סקיל מקושר (symlink) = הותקן מבחוץ.
    s.builtByUser = !s.isLink && (s.scope === "project" || !!w);
  }
  return skills;
}

// סקילים שמוזכרים בטקסט (בשמם המדויק, כמילה שלמה או אחרי /).
function skillsMentioned(text, skillIndex, selfName) {
  // רק הפעלה מפורשת של סקיל: "/שם", "skill: שם", "הסקיל שם", Skill("שם"), או שם ייחודי עם מקף/נקודתיים.
  // מילה רגילה שמופיעה בטקסט (video, human, social) היא לא חיבור.
  if (!text) return [];
  const out = [];
  for (const s of skillIndex) {
    if (s.name === selfName || s.name.length < 4) continue;
    const n = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const explicit = new RegExp(`(?:^|[\\s("'\`])\\/${n}\\b|\\bskill[s]?\\s*[:=(]?\\s*["'\`]?${n}\\b|הסקיל\\s+["'\`]?${n}\\b|סקיל\\s+["'\`]?${n}\\b|["'\`]${n}["'\`]\\s*(?:skill|סקיל)`, "mi");
    const distinctive = /[-:]/.test(s.name) && new RegExp(`(^|[\\s/"'\`(])${n}(?=$|[\\s"'\`),.:])`, "m");
    if ((explicit.test(text) || (distinctive && distinctive.test(text))) && !out.some((o) => o.name === s.name)) out.push(s);
  }
  return out.slice(0, 12);
}

const skillCard = (s) => ({
  name: s.name,
  description: s.description,
  path: s.path,
});

// ---------- 3. משימות מתוזמנות — מק (launchd) ----------

const HEB_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function describeCalendar(cal) {
  const list = Array.isArray(cal) ? cal : [cal];
  if (!list.length) return "";
  const one = (c) => {
    const t =
      c.Hour !== undefined
        ? ` ב-${hhmm(c.Hour, c.Minute)}`
        : c.Minute !== undefined
          ? ` בדקה ${c.Minute} של כל שעה`
          : "";
    if (c.Weekday !== undefined) return `כל יום ${HEB_DAYS[c.Weekday % 7]}${t}`;
    if (c.Day !== undefined) return `כל חודש ב-${c.Day} לחודש${t}`;
    if (c.Hour === undefined && c.Minute !== undefined) return `כל שעה${t}`;
    return `כל יום${t}`;
  };
  if (list.length <= 3) return list.map(one).join(" · ");
  const allDaily = list.every(
    (c) =>
      c.Weekday === undefined && c.Day === undefined && c.Hour !== undefined,
  );
  if (allDaily) return `${list.length} פעמים ביום`;
  return `${list.length} מועדים בשבוע`;
}

// כל המועדים המתוכננים בין from ל-to (עד 35 יום אחורה).
function occurrences(cal, from, to) {
  const list = Array.isArray(cal) ? cal : [cal];
  const out = [];
  const start = Math.max(from, to - 35 * DAY);
  const t = new Date(start);
  t.setSeconds(0, 0);
  for (let ms = t.getTime(); ms <= to; ms += MIN) {
    const d = new Date(ms);
    for (const c of list) {
      if (c.Month !== undefined && d.getMonth() + 1 !== c.Month) continue;
      if (c.Day !== undefined && d.getDate() !== c.Day) continue;
      if (c.Weekday !== undefined && d.getDay() !== c.Weekday % 7) continue;
      if (c.Hour !== undefined && d.getHours() !== c.Hour) continue;
      if ((c.Minute ?? 0) !== d.getMinutes()) continue;
      out.push(ms);
      break;
    }
  }
  return out;
}

// מתי המחשב היה פתוח (מתוך רשימת הכניסות של מק). כל רשומה: התחלה וסוף.
function macSessions() {
  const out = run("last", ["-100", os.userInfo().username]);
  if (!out) return [];
  const year = new Date(NOW).getFullYear();
  const list = [];
  for (const line of out.split("\n")) {
    const m = line.match(
      /console\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d)\s+(?:(still logged in)|- (?:crash|shutdown|\d\d:\d\d)\s+\((?:(\d+)\+)?(\d\d):(\d\d)\))/,
    );
    if (!m) continue;
    let start = Date.parse(`${m[1]} ${year}`);
    if (start > NOW + DAY) start = Date.parse(`${m[1]} ${year - 1}`);
    if (!Number.isFinite(start)) continue;
    if (m[2]) {
      list.push({ start, end: NOW, current: true });
    } else {
      const dur = ((Number(m[3] || 0) * 24 + Number(m[4])) * 60 + Number(m[5])) * MIN;
      list.push({ start, end: start + dur, current: false });
    }
  }
  return list;
}

function macBootTime() {
  const o = run("sysctl", ["-n", "kern.boottime"]);
  const m = o && o.match(/sec = (\d+)/);
  return m ? Number(m[1]) * 1000 : null;
}

const everyText = (sec) => {
  if (sec % 86400 === 0)
    return sec === 86400 ? "פעם ביום" : `כל ${sec / 86400} ימים`;
  if (sec % 3600 === 0)
    return sec === 3600 ? "כל שעה" : `כל ${sec / 3600} שעות`;
  const m = Math.round(sec / 60);
  return m === 1 ? "כל דקה" : `כל ${m} דקות`;
};

// "היום ב-08:00" / "אתמול ב-21:00" / "ביום שני ב-08:00"
function heWhen(ms) {
  const d = new Date(ms);
  const t = hhmm(d.getHours(), d.getMinutes());
  const today = new Date(NOW);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return `היום ב-${t}`;
  if (ms >= today.getTime() - DAY) return `אתמול ב-${t}`;
  if (ms >= today.getTime() - 6 * DAY) return `ביום ${HEB_DAYS[d.getDay()]} ב-${t}`;
  return `ב-${d.getDate()}.${d.getMonth() + 1} ב-${t}`;
}

// המועד המתוכנן האחרון שכבר עבר (או null אם אי אפשר לחשב).
function lastExpected(cal, now) {
  const list = Array.isArray(cal) ? cal : [cal];
  let best = null;
  for (const c of list) {
    // הולכים אחורה עד 35 יום ומחפשים את המועד האחרון שמתאים.
    for (let back = 0; back < 35 * 24; back++) {
      const d = new Date(now - back * HOUR);
      if (c.Month !== undefined && d.getMonth() + 1 !== c.Month) continue;
      if (c.Day !== undefined && d.getDate() !== c.Day) continue;
      if (c.Weekday !== undefined && d.getDay() !== c.Weekday % 7) continue;
      if (c.Hour !== undefined && d.getHours() !== c.Hour) continue;
      const t = new Date(d);
      t.setMinutes(c.Minute ?? 0, 0, 0);
      if (t.getTime() > now) continue;
      if (!best || t.getTime() > best) best = t.getTime();
      break;
    }
  }
  return best;
}

function plistJSON(file) {
  const out = run("plutil", ["-convert", "json", "-o", "-", file]);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function launchctlInfo(label) {
  const out = run("launchctl", ["print", `gui/${process.getuid()}/${label}`]);
  if (!out) return { loaded: false };
  const g = (re) => {
    const m = out.match(re);
    return m ? m[1] : null;
  };
  return {
    loaded: true,
    state: g(/\n\s*state = ([^\n]+)/),
    runs: Number(g(/\n\s*runs = (\d+)/) ?? NaN),
    lastExit: g(/\n\s*last exit code = ([^\n]+)/),
    pid: g(/\n\s*pid = (\d+)/),
  };
}

// קורא רק את תחילת הקובץ, ומדלג על קבצים בינאריים או ענקיים.
function readHead(file, max) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return "";
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(max, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.includes(0)) return "";
    return buf.toString("utf8");
  } catch {
    return "";
  }
}
const SCRIPT_EXT = /\.(js|mjs|cjs|ts|py|sh|zsh|bash|rb|ps1|bat|cmd|command)$/i;
const INTERPRETER = /[\\/](node|python[\d.]*|bash|zsh|sh|caffeinate|osascript|ruby|deno|bun|uv|npx|npm)(\.exe)?$/i;
// מתוך הפקודה של משימה: הקובץ שהמשתמש כתב (סקריפט), לא תוכנת ההרצה (node, python).
function pickScript(args) {
  const cands = args.filter((a) => typeof a === "string" && isUserPath(a) && !INTERPRETER.test(a) && !/[\\/](\.nvm|node_modules|\.venv|venv)[\\/]/.test(a) && exists(a));
  return [...cands].reverse().find((a) => SCRIPT_EXT.test(a)) || cands.find((a) => { try { return fs.statSync(a).isFile(); } catch { return false; } }) || null;
}

const isUserPath = (p) =>
  typeof p === "string" &&
  p.startsWith(HOME + path.sep) &&
  !p.startsWith(path.join(HOME, "Library") + path.sep);

function scriptHeader(file) {
  // רק שורות הערה בראש הקובץ, ומקסימום 25 שורות. לא שומרים את הקוד עצמו.
  let text;
  try {
    text = readHead(file, 4000);
  } catch {
    return "";
  }
  const lines = text.split("\n").slice(0, 25);
  const doc = [];
  let inDoc = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith("#!")) continue;
    if (/^("""|''')/.test(l)) {
      const rest = l
        .slice(3)
        .replace(/("""|''')$/, "")
        .trim();
      if (rest) doc.push(rest);
      if (inDoc || /("""|''')$/.test(l.slice(3))) {
        if (inDoc) break;
        else break;
      }
      inDoc = true;
      continue;
    }
    if (inDoc) {
      if (/("""|''')$/.test(l)) {
        const r = l.replace(/("""|''')$/, "").trim();
        if (r) doc.push(r);
        break;
      }
      doc.push(l);
      continue;
    }
    if (l.startsWith("#") || l.startsWith("//")) {
      const c = l.replace(/^(#+|\/\/+)\s?/, "").trim();
      if (c && !/^-{3,}|^={3,}|coding[:=]|eslint|@ts-/.test(c)) doc.push(c);
      continue;
    }
    if (l === "") continue;
    if (doc.length) break;
  }
  return clean(doc.slice(0, 3).join(" "), 200);
}

// ---- הקשר של סוכן מתוך התיקייה שלו: תפקיד, חיבורים, ותוצרים (רק ממה שכתוב, בלי לנחש) ----
function siblingText(script, scriptText) {
  // רק קבצים שהסקריפט באמת מפעיל או מייבא (שם הקובץ מופיע בקוד שלו), ועוד שכבה אחת מהם.
  if (!script) return "";
  const dir = path.dirname(script);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(py|js|mjs|cjs|ts|sh)$/i.test(f) && !/\.bak|backup/i.test(f) && path.join(dir, f) !== script); } catch { return ""; }
  const stem = (f) => f.replace(/\.[^.]+$/, "");
  const used = new Set();
  let frontier = [scriptText || readHead(script, 300000)];
  for (let depth = 0; depth < 2; depth++) {
    const next = [];
    for (const t of frontier) for (const f of files) {
      if (used.has(f)) continue;
      if (new RegExp(`\\b${stem(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) { used.add(f); next.push(readHead(path.join(dir, f), 300000)); }
    }
    frontier = next;
  }
  return [...used].map((f) => readHead(path.join(dir, f), 300000)).join("\n");
}
// מסמך תפקיד שבעל העסק כתב (01_תפקיד_הסוכן.md, README, CLAUDE.md) בתיקייה של הסוכן או מעליה
function roleDoc(startDir) {
  // רק מסמך תפקיד של הסוכן עצמו: בתיקייה שלו, או בתיקיית _agent לידה. לא README כללי של תיקייה גדולה יותר.
  if (!startDir) return null;
  const places = [startDir, path.join(startDir, "_agent"), path.join(path.dirname(startDir), "_agent")];
  for (const sub of places) {
    let list = [];
    try { list = fs.readdirSync(sub); } catch { continue; }
    const cands = list.filter((f) => /\.md$/i.test(f) && /תפקיד|role/i.test(f)).map((f) => path.join(sub, f));
    for (const c of cands) {
      const t = readHead(c, 6000);
      const sec = t.match(/##\s*(?:מטרה|תפקיד|מה (?:הוא|זה) עושה|purpose|goal)[^\n]*\n+([^#][\s\S]*?)(?:\n\s*\n|\n#)/i);
      const para = sec ? sec[1] : (t.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*(#|>|---|\|)/.test(p)) || "");
      const txt = clean(para.replace(/[*_`>]/g, ""), 320);
      // התוצאה: הפסקה תחת "תוצר / תוצאה / פלט / מה מקבלים", אם יש כזו במסמך
      const g = t.match(/##+\s*(?:ה?תוצר(?:ים)?|ה?תוצא(?:ה|ות)|ה?פלט(?:ים)?|מה (?:מקבלים|הוא מביא|הוא מייצר)|outputs?|deliverables?)(?=[\s:—-]|$)[^\n]*\n+(?!\s*#)([^#\n][\s\S]*?)(?:\n\s*\n|\n#|$)/i);
      const goal = g ? clean(g[1].replace(/[*_`>|]/g, " "), 260) : null;
      if (txt.length > 25) return { text: txt, file: c, goal };
    }
  }
  return null;
}
// לאן הסוכן שם את התוצרים: תיקיות בדרייב (מזהה שכתוב בקוד), תיקיית דרייב מסונכרנת, ותיקיות שהלוג מדווח עליהן
// sib: קבצים שהסקריפט מייבא. תיקייה בדרייב שמופיעה רק שם נחשבת רק אם בסקריפט ובלוג שלו לא נמצא שום יעד,
// כי סקריפט שמייבא כלים מסקריפט אחר לא בהכרח שומר לאותה תיקייה.
function findOutputs(code, logFiles, sib = "") {
  const out = [];
  const seen = new Set();
  const add = (o) => { if (!seen.has(o.key)) { seen.add(o.key); out.push(o); } };
  const driveIn = (text) => {
  for (const m of String(text).matchAll(/([A-Z_]*(?:DRIVE|FOLDER)[A-Z_]*)\s*=\s*["'](1[A-Za-z0-9_-]{24,43})["']/g)) {
    const nameM = String(text).match(new RegExp(m[1].replace(/_ID$/, "") + "_NAME\\s*=\\s*[\"']([^\"']{2,60})[\"']"));
    add({ key: m[2], type: "drive", label: nameM ? nameM[1] : "תיקייה בדרייב", url: `https://drive.google.com/drive/folders/${m[2]}` });
  }
  for (const m of String(text).matchAll(/CloudStorage\/GoogleDrive-[^/"']+\/[^"'\n]*?\/([^/"'\n]{2,60})["']/g)) add({ key: "gd:" + m[1], type: "drive-local", label: m[1] });
  };
  driveIn(code);
  for (const f of logFiles) {
    if (!f) continue;
    let st; try { st = fs.statSync(f); } catch { continue; }
    const n = Math.min(20000, st.size);
    const buf = Buffer.alloc(n);
    try { const fd = fs.openSync(f, "r"); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd); } catch { continue; }
    const tail = buf.toString("utf8");
    for (const m of tail.matchAll(/(?:Output|output|נשמר|נשמרו|נכתב|saved(?: to)?)\s*:?\s*(\/Users\/[^\n]+?)\s*$/gm)) {
      let p = m[1].trim();
      try { if (fs.statSync(p).isFile()) p = path.dirname(p); } catch {}
      p = p.replace(/\/\d{4}-\d{2}(-\d{2})?$/, "");
      add({ key: "f:" + p, type: "folder", label: path.basename(p), path: p });
    }
    if (/נשלח במייל|email sent|mail sent/i.test(tail)) add({ key: "mail", type: "mail", label: "דוח במייל" });
    if (/whatsapp delivered|נשלח לוואטסאפ|נשלח בוואטסאפ|sent to whatsapp/i.test(tail)) add({ key: "wa", type: "whatsapp", label: "הודעה בוואטסאפ" });
    if (/הועלה לדרייב|uploaded to drive/i.test(tail) && !out.some((o) => o.type === "drive" || o.type === "drive-local")) add({ key: "drive?", type: "drive-local", label: "קבצים בדרייב" });
  }
  if (!out.length && sib) driveIn(sib);
  const named = out.filter((o) => o.type === "drive" && o.label !== "תיקייה בדרייב");
  const res = out.filter((o) => !(o.type === "drive" && o.label === "תיקייה בדרייב" && named.length) && !(o.type === "drive-local" && out.some((x) => x.type === "drive")));
  return res.slice(0, 6);
}

// כשאין קוד יציאה: מה כתוב בסוף הלוג של הריצה? הצלחה מפורשת או שגיאה מפורשת. אחרת לא קובעים.
const LOG_OK = /✅|\bdone\b|\bsuccess|\bsent\b|\bfinished\b|\bcompleted\b|נשלח|נשמר|סיום|הושלם|הסתיים בהצלחה/i;
const LOG_BAD = /traceback|\berror\b|exception|\bfailed\b|timed out|timeoutexpired|\bfatal\b|❌|נכשל|שגיאה|(?:^|[\s:\-(])כשל(?:ים|ון)?(?=$|[\s:.,)!])/i;
// ביטויים של "אפס תקלות" מוסרים מהשורה לפני הבדיקה (ולא פוסלים את כל השורה, כדי ש"errors: 0, failed: 3" עדיין ייתפס)
const LOG_ZERO = /\b0\s*(?:failed|errors?|fatal)\b|\b(?:errors?|failed|fatal)\s*[=:]\s*0\b|no (?:fatal )?errors?|(?:^|[^\d])0\s*(?:נכשלו|כשלים|שגיאות)|(?:נכשלו|שגיאות|כשלים)\s*[=:]\s*0(?!\d)|ללא (?:שגיאות|כשלים)|אין (?:שגיאות|כשלים)/gi;
function logVerdict(files, since) {
  let ok = null, bad = null, partial = null;
  for (const f of files) {
    try {
    if (!f) continue;
    const m = mtime(f);
    if (!m || m < since) continue;
    let tail = "";
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, "r");
      const n = Math.min(4000, st.size);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      fs.closeSync(fd);
      tail = buf.toString("utf8");
    } catch { continue; }
    const lines = tail.split("\n").filter((l) => l.trim()).slice(-15);
    const isBadL = (l) => {
      const t = l.replace(LOG_ZERO, " ");
      if (!LOG_BAD.test(t)) return false;
      // הודעה שהמערכת מנסה שוב או ממשיכה היא לא כישלון, אלא אם כתוב בה שהיא ויתרה
      if (/retrying|will retry|מנסה שוב|ממשיך|continuing/i.test(t) && !/giving up|gave up|permanently|max retries|ויתר|נכשל סופית/i.test(t)) return false;
      return true;
    };
    const bi = lines.findIndex(isBadL);
    const lastOk = lines.map((l, i) => (LOG_OK.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    if (bi >= 0) {
      // הסבר במילים במקום שורת קוד, כשאפשר לזהות מה קרה
      const t = lastOk < bi && lines.slice(bi).some((l) => isBadL(l) && /timed out|timeoutexpired/i.test(l))
        ? "הריצה נעצרה כי לקחה יותר מדי זמן"
        : clean(lines[bi].replace(/^\[[^\]]*\]\s*/, ""), 120);
      // שגיאה ואחריה סיום מוצלח = הריצה הסתיימה, אבל חלק ממנה נכשל
      if (lastOk > bi) partial = t;
      else bad = t;
    } else if (lastOk >= 0) ok = true;
    } catch {
      // לוג שאי אפשר לקרוא פשוט לא נחשב
    }
  }
  return bad ? { bad } : partial ? { partial } : ok ? { ok: true } : null;
}

function brokenAgent(id, name, file) {
  return { id, name, kind: "scheduled", kindLabel: "משימה קבועה", type: "agent", where: "computer", autonomous: true, schedule: "—", status: "unknown", statusWhy: `לא הצלחתי לקרוא את ההגדרות שלו${file ? ` (${file})` : ""}, אז אין עליו מידע`, description: "", files: file ? [file] : [], skills: [], services: [], links: [], flow: { chain: [], branches: [] }, session: null };
}
function scanLaunchd(skillIndex, writes) {
  const dir = path.join(HOME, "Library", "LaunchAgents");
  if (!exists(dir)) return [];
  const agents = [];
  const state = readJSON(path.join(DATA, "launchd-state.json"), {});
  const newState = {};
  // משימות של המשתמש נטענות כשנכנסים למחשב, ולכן סופרים ריצות מרגע הכניסה.
  const SESS = macSessions();
  const current = SESS.find((x) => x.current);
  const BOOT = current ? current.start : macBootTime();
  const wasOpen = (t) =>
    SESS.length ? SESS.some((x) => t >= x.start && t <= x.end + MIN) : null;
  const seenLabels = new Set();
  // קודם קבצים פעילים, אחר כך מכובים, כדי שעותק מכובה של משימה פעילה לא יופיע פעמיים.
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.plist(\.disabled)?$/.test(f))
    .sort((a, b) => a.endsWith(".disabled") - b.endsWith(".disabled"));

  for (const f of files) {
    let pl = null;
    try {
    const file = path.join(dir, f);
    const disabledFile = f.endsWith(".disabled");
    pl = plistJSON(file);
    if (!pl || !pl.Label) continue;
    if (seenLabels.has(pl.Label)) continue;
    seenLabels.add(pl.Label);
    const args = pl.ProgramArguments || (pl.Program ? [pl.Program] : []);
    const script = pickScript(args);
    const userish =
      script ||
      isUserPath(pl.WorkingDirectory) ||
      isUserPath(pl.StandardOutPath);
    if (!userish) continue; // משימות של תוכנות אחרות (עדכונים של גוגל, אדובי וכו׳)
    // גיבויים ישנים של אותה משימה
    if (/\.bak/.test(f)) continue;

    const label = pl.Label;
    const isSelf = label === "com.ceo-agent.check";
    // מתי המשימה נטענה: לא לפני הכניסה למחשב, ולא לפני שקובץ ההגדרות שלה נוצר או שונה.
    // משימה שנוצרה ב-14:00 לא "פספסה" את 08:00 של אותו בוקר.
    const LOADED = Math.max(BOOT || 0, mtime(file) || 0);
    const info = disabledFile ? { loaded: false } : launchctlInfo(label);
    const logPath = pl.StandardOutPath || pl.StandardErrorPath || null;
    const logM = logPath ? mtime(logPath) : null;
    const errM =
      pl.StandardErrorPath && pl.StandardErrorPath !== logPath
        ? mtime(pl.StandardErrorPath)
        : null;
    const lastSeen = Math.max(logM || 0, errM || 0) || null;

    // מה ידוע מסריקות קודמות (הבדיקה המתוזמנת סורקת כל שעה ושומרת).
    const prev = state[label] || {};
    const runs = Number.isFinite(info.runs) ? info.runs : null;
    let lastRunEvidence = lastSeen;
    let evidence = lastSeen ? "לפי קובץ הלוג" : "";

    const cal = pl.StartCalendarInterval;
    // KeepAlive=true, או מילון בלי תזמון ובלי "רק כשנכשל" = אמור לרוץ ברציפות.
    const keepAlive =
      pl.KeepAlive === true ||
      (pl.KeepAlive &&
        typeof pl.KeepAlive === "object" &&
        !cal &&
        !pl.StartInterval &&
        pl.KeepAlive.SuccessfulExit !== false);
    const interval = pl.StartInterval;
    let schedule = "ידני";
    let autonomous = true;
    if (keepAlive) schedule = "פועל ברציפות";
    else if (cal) schedule = describeCalendar(cal);
    else if (interval) schedule = everyText(interval);
    else if (pl.RunAtLoad) schedule = "בכל הדלקה של המחשב";
    else autonomous = false;

    // ---- סטטוס מהוכחה ----
    let status = "unknown";
    let why = "";
    const exitCode =
      info.lastExit && /^-?\d+$/.test(info.lastExit)
        ? Number(info.lastExit)
        : null;
    const neverRan = info.lastExit && /never exited/i.test(info.lastExit);

    if (disabledFile || pl.Disabled === true) {
      status = "off";
      why = "המשימה מכובה";
    } else if (!info.loaded) {
      status = "off";
      why = "המשימה לא טעונה במחשב, ולכן לא תרוץ";
    } else if (keepAlive) {
      if (info.pid) {
        status = "ok";
        why = "רץ עכשיו ברקע";
      } else {
        status = "failed";
        why =
          exitCode !== null
            ? `אמור לרוץ ברציפות אבל עצר (קוד יציאה ${exitCode})`
            : "אמור לרוץ ברציפות אבל לא רץ עכשיו";
      }
    } else if (info.pid && !isSelf) {
      // רץ עכשיו. בודקים שהוא לא תקוע: כמה זמן התהליך כבר רץ.
      const el = Number((run("ps", ["-o", "etime=", "-p", info.pid]) || "").trim().split(/[-:]/).reverse().reduce((acc, v, i) => acc + Number(v) * [1, 60, 3600, 86400][i], 0));
      // רק משימה מתוזמנת יכולה להיתקע: ריצה שלא נגמרת חוסמת את הריצה הבאה.
      // משימה שעולה פעם אחת בהדלקה ונשארת לרוץ, זה בדיוק מה שהיא אמורה לעשות.
      const limit = interval ? Math.max(interval * 2, 3600) : cal ? 6 * 3600 : Infinity;
      if (Number.isFinite(el) && el > limit) {
        status = "failed";
        why = `תקוע: רץ כבר ${el >= 86400 ? Math.round(el / 86400) + " ימים" : Math.round(el / 3600) + " שעות"} בלי לסיים, ולכן הריצות הבאות שלו לא מתחילות`;
      } else {
        status = "ok";
        why = cal || interval ? "רץ ממש עכשיו" : "רץ ברקע";
      }
      evidence = "המחשב מראה שהוא רץ עכשיו";
    } else if (isSelf) {
      // הבדיקה הקבועה של סוכן מנכ״ל עצמו: לפי הדוח שהיא כותבת אחרי כל ריצה.
      const h = readJSON(path.join(DATA, "alert-health.json"), null);
      const last = h && Date.parse(h.lastRunAt);
      if (!h || !last) { status = "unknown"; why = "עוד לא רצה אף פעם"; }
      else if (h.disabled && last >= NOW - 45 * MIN) { status = "ok"; why = "מעדכנת את הדשבורד כל רבע שעה (ההתראות בוואטסאפ כבויות)"; lastRunEvidence = last; }
      else if (h.lastError) { status = "failed"; why = `רצה, אבל ההתראה האחרונה לא נשלחה: ${clean(h.lastError, 100)}`; lastRunEvidence = last; }
      else if (last < NOW - 45 * MIN) { status = "missed"; why = `לא רצה מאז ${heWhen(last)}`; lastRunEvidence = last; }
      else { status = "ok"; why = "רצה בזמן, וההתראות האחרונות נשלחו"; lastRunEvidence = last; }
      evidence = "לפי הדוח של הבדיקה עצמה";
    } else if (cal || interval) {
      // שואלים: האם המועד האחרון שכבר עבר (לפני יותר מ-20 דקות) באמת רץ?
      const grace = 20 * MIN;
      const E = cal
        ? lastExpected(cal, NOW - grace)
        : NOW - interval * 1000 - grace;
      // כמה ריצות היו אמורות להיות מאז שהמחשב עלה, מול כמה המחשב ספר בפועל.
      const dueSinceBoot =
        BOOT && cal
          ? occurrences(cal, BOOT, NOW - grace).length
          : BOOT && interval
            ? Math.max(
                1,
                Math.floor((NOW - grace - BOOT) / (interval * 1000)) -
                  1 +
                  (pl.RunAtLoad ? 1 : 0),
              )
            : null;
      const counterProves =
        runs !== null && dueSinceBoot !== null && dueSinceBoot > 0
          ? runs >= dueSinceBoot
          : false;
      const logProves = E && lastSeen && lastSeen >= E - 2 * MIN;
      const prevProves = E && prev.lastRunAt && prev.lastRunAt >= E - 2 * MIN;
      // המונה עלה מאז הבדיקה הקודמת (באותה כניסה למחשב) = רץ אחרי הבדיקה ההיא.
      const sameLogin = prev.boot && BOOT && Math.abs(prev.boot - BOOT) < 2 * MIN;
      const deltaProves =
        sameLogin && runs !== null && Number.isFinite(prev.runs) && runs > prev.runs && prev.scannedAt <= E + grace;
      const ran = interval
        ? counterProves || logProves || prevProves || deltaProves
        : !!E && (logProves || prevProves || deltaProves || (E >= LOADED && counterProves));
      // הוכחה שלא רץ: המונה לא זז בכלל מאז הכניסה, או לא זז מאז בדיקה שהייתה לפני המועד.
      const provenNotRun =
        (E >= LOADED && runs === 0 && NOW - LOADED > grace) ||
        (sameLogin && prev.scannedAt < E && runs !== null && runs === prev.runs);

      if (!E) {
        status = "unknown";
        why = "אי אפשר לחשב מתי היה אמור לרוץ";
      } else if (ran) {
        if (counterProves && !logProves) {
          lastRunEvidence = Math.max(
            lastRunEvidence || 0,
            cal ? E : NOW - grace,
          );
          evidence = "לפי מונה הריצות של המחשב";
        } else if (prevProves && !logProves) {
          lastRunEvidence = Math.max(lastRunEvidence || 0, prev.lastRunAt);
          evidence = "לפי בדיקה קודמת של סוכן מנכ״ל";
        }
        // קוד היציאה של launchd שייך לריצה האחרונה מאז שהמחשב עלה.
        const exitIsFresh =
          runs >= 1 && exitCode !== null && (!cal || E >= BOOT || !BOOT);
        const knownExit = exitIsFresh
          ? exitCode
          : prev.lastExitAt && prev.lastExitAt >= E - 2 * MIN
            ? prev.lastExit
            : null;
        if (knownExit === 0) {
          status = "ok";
          why = "רץ בזמן ולא החזיר שגיאה";
        } else if (knownExit !== null) {
          status = "failed";
          why = `רץ, אבל הסתיים בשגיאה (קוד יציאה ${knownExit})`;
        } else {
          // אין קוד יציאה (המחשב הופעל מחדש מאז). בודקים מה הלוג של הריצה אומר.
          const v = logVerdict([pl.StandardOutPath, pl.StandardErrorPath], E - 2 * MIN);
          if (v && v.bad) { status = "failed"; why = `רץ ${heWhen(lastRunEvidence || E)}, אבל בלוג יש שגיאה: ${v.bad}`; evidence = "לפי הלוג שלו"; }
          else if (v && v.partial) { status = "partial"; why = `רץ ${heWhen(lastRunEvidence || E)} והסתיים, אבל חלק ממנו נכשל: ${v.partial}`; evidence = "לפי הלוג שלו"; }
          else if (v && v.ok) { status = "ok"; why = `רץ ${heWhen(lastRunEvidence || E)}, והלוג שלו מראה שהסתיים בהצלחה`; evidence = "לפי הלוג שלו"; }
          else { status = "unknown"; why = "רץ בזמן, אבל המחשב הופעל מחדש מאז ואין בלוג סימן להצלחה או לשגיאה"; }
        }
      } else if (provenNotRun) {
        status = "missed";
        why = `היה אמור לרוץ ${heWhen(E)} ולא רץ`;
      } else if (E < BOOT && wasOpen(E) === false) {
        status = "missed";
        why = `היה אמור לרוץ ${heWhen(E)} ולא רץ, כי המחשב היה כבוי או סגור בזמן הזה`;
      } else {
        status = "unknown";
        why = `היה אמור לרוץ ${heWhen(E)}, ואין הוכחה שרץ או שלא רץ`;
      }
    } else if (exitCode !== null && runs >= 1) {
      status = exitCode === 0 ? "ok" : "failed";
      why =
        exitCode === 0
          ? "הריצה האחרונה הסתיימה בלי שגיאה"
          : `הריצה האחרונה הסתיימה בשגיאה (קוד יציאה ${exitCode})`;
      evidence = "לפי קוד היציאה במחשב";
    }

    newState[label] = {
      boot: BOOT,
      runs,
      scannedAt: NOW,
      lastRunAt: Math.max(lastRunEvidence || 0, prev.lastRunAt || 0) || null,
      lastExit:
        runs >= 1 && exitCode !== null ? exitCode : (prev.lastExit ?? null),
      lastExitAt:
        runs >= 1 && exitCode !== null
          ? lastRunEvidence || NOW
          : (prev.lastExitAt ?? null),
    };

    const header = script ? scriptHeader(script) : "";
    let scriptText = "";
    if (script) {
      try {
        scriptText = readHead(script, 200000);
      } catch {}
    }
    const used = skillsMentioned(scriptText, skillIndex, null);
    const sib = siblingText(script, scriptText);
    const services = detectServices(scriptText + "\n" + sib);
    const aiInside = usesClaude(scriptText) || usesClaude(sib);
    const links = detectLinks(scriptText + "\n" + sib);
    const outputs = findOutputs(scriptText, [pl.StandardOutPath, pl.StandardErrorPath], sib);
    const role = roleDoc(pl.WorkingDirectory || (script ? path.dirname(script) : null));
    scriptText = "";

    const projectDir =
      pl.WorkingDirectory || (script ? path.dirname(script) : null);
    const w = (script && writes[script]) || writes[file] || null;
    const niceName =
      label === "com.ceo-agent.check"
        ? "סוכן מנכ״ל — בדיקה קבועה"
        : label.replace(/^com\.[^.]+\./, "").replace(/[-_.]/g, " ");

    agents.push({
      id: `launchd:${label}`,
      name: niceName,
      kind: "scheduled",
      kindLabel: "משימה מתוזמנת",
      where: "computer",
      autonomous,
      schedule,
      status,
      statusWhy: why,
      evidence: evidence || "",
      lastRun: iso(lastRunEvidence),
      description: header,
      project: projectDir ? path.basename(projectDir) : null,
      projectDir,
      folder: projectDir,
      files: [script, file].filter(Boolean),
      skills: used.map(skillCard),
      type: aiInside ? "combo" : "automation",
      typeLabel: TYPE_LABEL[aiInside ? "combo" : "automation"],
      services,
      links,
      outputs,
      // התפקיד: התיאור בראש הסקריפט אם הוא בעברית ומפורט (הכי ספציפי), אחרת מסמך התפקיד של הסוכן
      role: /[\u0590-\u05FF]/.test(header) && header.length > 30 ? header : role ? role.text : header || null,
      roleFile: role ? role.file : null,
      goal: role && role.goal ? role.goal : null,
      partOf: role && /[\u0590-\u05FF]/.test(header) && header.length > 30 ? role.text : null,
      flow: buildFlow({
        trigger: { label: schedule, sub: "מתי הוא רץ", emo: "⏰" },
        main: { label: script ? path.basename(script) : niceName, sub: aiInside ? "סקריפט שמפעיל את Claude" : "סקריפט", emo: aiInside ? "🤖" : "⚙️" },
        chain: outputs.length ? [{ label: outputs.map((o) => o.label).slice(0, 2).join(" · "), sub: "התוצר", emo: "📦" }] : undefined,
        skills: used.map(skillCard),
        services,
      }),
      session: w ? w.session : null,
      sessionCwd: w ? w.cwd : null,
    });
      } catch (e) {
      // קובץ פגום אחד לא עוצר את כל הסריקה: הוא מוצג כ"לא ידוע" עם השם שלו
      // המזהה לפי ה-Label אם הצלחנו לקרוא אותו, כדי שסוכן שסומן כשלי לא יופיע גם כ"נעלם"
      const bid = `launchd:${pl && pl.Label ? pl.Label : f}`;
      if (agents.some((x) => x.id === bid)) continue;
      if (pl && pl.Label) seenLabels.add(pl.Label);
      agents.push(brokenAgent(bid, (pl && pl.Label) || f, path.join(dir, f)));
    }
  }
  fs.writeFileSync(
    path.join(DATA, "launchd-state.json"),
    JSON.stringify(newState),
  );
  return agents;
}

// ---------- 4. משימות מתוזמנות — ווינדוס (Task Scheduler) ----------

// בווינדוס משימה יכולה להיכתב עם %USERPROFILE% או עם לוכסנים רגילים. מיישרים לפני שמשווים.
const winNorm = (x) =>
  String(x || "")
    .replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m)
    .replace(/\//g, "\\");
function scanWindowsTasks(skillIndex, writes) {
  const ps = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  [pscustomobject]@{
    Name=$_.TaskName; State=[string]$_.State; Desc=$_.Description;
    Exec=($_.Actions | Select-Object -First 1).Execute;
    Args=($_.Actions | Select-Object -First 1).Arguments;
    Dir=($_.Actions | Select-Object -First 1).WorkingDirectory;
    Triggers=@($_.Triggers | ForEach-Object { [pscustomobject]@{ Type=$_.CimClass.CimClassName; Start=$_.StartBoundary; Days=$_.DaysInterval; Weeks=$_.WeeksInterval; DOW=$_.DaysOfWeek; Rep=$_.Repetition.Interval; Enabled=$_.Enabled } });
    LastRun=if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{$null};
    NextRun=if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{$null};
    Result=$i.LastTaskResult; Missed=$i.NumberOfMissedRuns
  }
} | ConvertTo-Json -Depth 5`;
  const out = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { timeout: 60000 },
  );
  // אם PowerShell לא החזיר תשובה, זה "לא נבדק", לא "אין משימות".
  if (out === null) return { checked: false, agents: [] };
  if (!out.trim()) return { checked: true, agents: [] };
  let list;
  try {
    list = JSON.parse(out);
  } catch {
    return { checked: false, agents: [] };
  }
  if (!Array.isArray(list)) list = [list];
  const userProfile = process.env.USERPROFILE || HOME;
  const agents = [];
  for (const t of list) {
    try {
    // משימה של המשתמש = הסקריפט או התיקייה שלה בתוך תיקיית המשתמש (לא ב-AppData).
    // תוכנת ההרצה עצמה (python, node) יכולה לשבת ב-AppData, וזה בסדר.
    const up = userProfile.toLowerCase();
    const mine = (x) => {
      const v = winNorm(x).toLowerCase();
      return v.includes(up) && !/\\appdata\\/i.test(v.slice(v.indexOf(up)));
    };
    const inUser = mine(t.Args) || mine(t.Dir) || (mine(t.Exec) && !/\.exe$/i.test(winNorm(t.Exec)));
    if (!inUser) continue; // רק משימות שהמשתמש יצר על קבצים שלו
    const trig = (t.Triggers || [])[0] || {};
    let schedule = "ידני";
    const startT = trig.Start ? new Date(trig.Start) : null;
    const at = startT
      ? ` ב-${hhmm(startT.getHours(), startT.getMinutes())}`
      : "";
    if (/Daily/i.test(trig.Type || ""))
      schedule = trig.Days > 1 ? `כל ${trig.Days} ימים${at}` : `כל יום${at}`;
    else if (/Weekly/i.test(trig.Type || "")) schedule = `כל שבוע${at}`;
    else if (/Logon/i.test(trig.Type || "")) schedule = "בכל כניסה למחשב";
    else if (/Boot/i.test(trig.Type || "")) schedule = "בכל הדלקה של המחשב";
    else if (/Time/i.test(trig.Type || "") && trig.Rep)
      schedule = `חוזר כל ${trig.Rep.replace(/^PT/, "").toLowerCase()}`;
    const autonomous = schedule !== "ידני";

    const lastRun = t.LastRun ? Date.parse(t.LastRun) : null;
    const nextRun = t.NextRun ? Date.parse(t.NextRun) : null;
    const res = Number(t.Result);
    const isSelf = t.Name === "CEO Agent Check";
    // כל כמה זמן המשימה אמורה לרוץ, ומכאן מתי הייתה הריצה הקודמת שהייתה צריכה לקרות.
    const isoDur = (d) => {
      const m = String(d || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
      return m ? ((+m[1] || 0) * 24 * 60 + (+m[2] || 0) * 60 + (+m[3] || 0)) * MIN : 0;
    };
    const period = trig.Rep
      ? isoDur(trig.Rep)
      : /Daily/i.test(trig.Type || "")
        ? (trig.Days || 1) * DAY
        : /Weekly/i.test(trig.Type || "")
          ? (trig.Weeks || 1) * 7 * DAY
          : 0;
    const grace = 20 * MIN;
    // המועד האחרון שהמשימה הייתה אמורה לרוץ בו, לפי כל הטריגרים שלה (יומי, שבועי לפי ימים, חוזר).
    const prevDue = (tr) => {
      if (!tr || !tr.Start) return null;
      const st = new Date(tr.Start);
      const cutoff = NOW - 20 * MIN;
      if (/Daily/i.test(tr.Type || "") || /Weekly/i.test(tr.Type || "")) {
        for (let back = 0; back < 15; back++) {
          const d = new Date(cutoff - back * DAY);
          d.setHours(st.getHours(), st.getMinutes(), 0, 0);
          if (d.getTime() > cutoff || d.getTime() < st.getTime()) continue;
          if (/Weekly/i.test(tr.Type || "") && tr.DOW && !((tr.DOW >> d.getDay()) & 1)) continue;
          if (/Daily/i.test(tr.Type || "") && (tr.Days || 1) > 1) return null; // כל כמה ימים: לא מחשבים, כדי לא לטעות
          return d.getTime();
        }
        return null;
      }
      if (tr.Rep && nextRun) return nextRun - isoDur(tr.Rep);
      return null;
    };
    const dues = (t.Triggers || []).filter((x) => x && x.Enabled !== false).map(prevDue).filter(Boolean);
    const prevExpected = dues.length ? Math.max(...dues) : nextRun && period ? nextRun - period : null;
    const neverRan = res === 267011 || !lastRun || lastRun < Date.parse("2000-01-01");
    let status = "unknown",
      why = "";
    if (/Disabled/i.test(t.State)) {
      status = "off";
      why = "המשימה מכובה";
    } else if (isSelf) {
      const h = readJSON(path.join(DATA, "alert-health.json"), null);
      const last = h && Date.parse(h.lastRunAt);
      if (h && h.disabled) { status = "off"; why = "ההתראות כבויות בהגדרות"; }
      else if (!last) { status = "unknown"; why = "עוד לא רצה אף פעם"; }
      else if (h.lastError) { status = "failed"; why = `רצה, אבל ההתראה האחרונה לא נשלחה: ${clean(h.lastError, 100)}`; }
      else if (last < NOW - 45 * MIN) { status = "missed"; why = `לא רצה מאז ${heWhen(last)}`; }
      else { status = "ok"; why = "רצה בזמן, וההתראות האחרונות נשלחו"; }
    } else if (/Running/i.test(t.State) || res === 267009) {
      // רק משימה מתוזמנת יכולה להיתקע. משימה שעולה בכניסה למחשב ונשארת לרוץ (כמו העוזר) תקינה.
      if (period && lastRun && NOW - lastRun > Math.max(period * 2, 3 * HOUR)) {
        status = "failed";
        why = `תקוע: רץ מאז ${heWhen(lastRun)} בלי לסיים`;
      } else {
        status = "ok";
        why = "רץ ממש עכשיו";
      }
    } else if (neverRan) {
      if (prevExpected && prevExpected < NOW - grace) {
        status = "missed";
        why = "היה אמור לרוץ כבר, ועוד לא רץ אף פעם";
      } else {
        status = "unknown";
        why = "עוד לא רץ אף פעם";
      }
    } else if (res !== 0) {
      status = "failed";
      why = `הריצה האחרונה הסתיימה בשגיאה (קוד ${res})`;
    } else if (prevExpected && prevExpected < NOW - grace && lastRun < prevExpected - 2 * MIN) {
      status = "missed";
      why = `היה אמור לרוץ ${heWhen(prevExpected)} ולא רץ (אולי המחשב היה כבוי)`;
    } else if (!period) {
      status = "ok";
      why = "הריצה האחרונה הסתיימה בלי שגיאה";
    } else {
      status = "ok";
      why = "רץ בזמן ולא החזיר שגיאה";
    }

    const script = [t.Args, t.Exec]
      .map((x) =>
        winNorm(x).match(/[A-Za-z]:\\[^"]+\.(py|js|mjs|ps1|bat|cmd|sh)/i),
      )
      .find(Boolean);
    const scriptPath = script ? script[0] : null;
    let scriptText = "";
    if (scriptPath) {
      try {
        scriptText = readHead(scriptPath, 200000);
      } catch {}
    }
    const used = skillsMentioned(scriptText, skillIndex, null);
    const services = detectServices(scriptText);
    const aiInside = usesClaude(scriptText);
    const links = detectLinks(scriptText);
    scriptText = "";
    const w = scriptPath ? writes[scriptPath] : null;
    const projectDir = (t.Dir ? winNorm(t.Dir) : "") || (scriptPath ? path.dirname(scriptPath) : null);
    agents.push({
      id: `task:${t.Name}`,
      name: t.Name === "CEO Agent Check" ? "סוכן מנכ״ל — בדיקה קבועה" : t.Name,
      kind: "scheduled",
      kindLabel: "משימה מתוזמנת",
      where: "computer",
      autonomous,
      schedule,
      status,
      statusWhy: why,
      evidence: "לפי מתזמן המשימות של ווינדוס",
      lastRun: iso(lastRun),
      nextRun: iso(nextRun),
      description: clean(
        t.Desc || (scriptPath ? scriptHeader(scriptPath) : ""),
        200,
      ),
      project: projectDir ? path.basename(projectDir) : null,
      projectDir,
      files: [scriptPath].filter(Boolean),
      skills: used.map(skillCard),
      folder: projectDir,
      type: aiInside ? "combo" : "automation",
      typeLabel: TYPE_LABEL[aiInside ? "combo" : "automation"],
      services,
      links,
      flow: buildFlow({
        trigger: { label: schedule, sub: "מתי הוא רץ", emo: "⏰" },
        main: { label: scriptPath ? path.basename(scriptPath) : t.Name, sub: aiInside ? "סקריפט שמפעיל את Claude" : "סקריפט", emo: aiInside ? "🤖" : "⚙️" },
        skills: used.map(skillCard),
        services,
      }),
      session: w ? w.session : null,
      sessionCwd: w ? w.cwd : null,
    });
      } catch (e) {
      // קובץ פגום אחד לא עוצר את כל הסריקה: הוא מוצג כ"לא ידוע" עם השם שלו
      agents.push(brokenAgent(`task:${(t && t.Name) || "?"}`, (t && t.Name) || "משימה", ""));
    }
  }
  return { checked: true, agents };
}

// ---------- 5. העוזר האישי בוואטסאפ ----------

const ASSIST_STATE = path.join(DATA, "assistant-state.json");
function saveAssistantState(badSince) {
  try {
    fs.writeFileSync(ASSIST_STATE, JSON.stringify({ badSince }));
  } catch {}
}

function scanAssistant(agents) {
  const dir = path.join(HOME, "talbs-whatsapp-bot");
  if (!exists(dir)) return null;
  const desc =
    "העוזר האישי בוואטסאפ: עונה לך מהטלפון ומעביר לך את ההתראות של סוכן מנכ״ל.";
  // במק הוא כבר נמצא כמשימה מתוזמנת. מסמנים אותה כעוזר האישי במקום להוסיף כפילות.
  let a = agents.find(
    (x) =>
      x.files.some((f) => f.startsWith(dir + path.sep)) ||
      /workshop-bot/.test(x.id),
  );
  if (!a) {
    // ווינדוס, או התקנה בלי משימה: בודקים אם המסך שלו עונה.
    const out = run(IS_WIN ? "curl.exe" : "curl", [
      "-s", "-m", "3", "-o", IS_WIN ? "NUL" : "/dev/null", "-w", "%{http_code}",
      "http://127.0.0.1:7655/",
    ]);
    const up = !!(out && /^[1-4]\d\d$/.test(out.trim()));
    a = {
      id: "assistant",
      where: "computer",
      autonomous: true,
      schedule: "פועל ברציפות",
      status: up ? "ok" : "failed",
      statusWhy: up ? "המסך של העוזר עונה" : "העוזר מותקן אבל לא עונה כרגע",
      evidence: "בדיקה ישירה מול העוזר",
      lastRun: up ? iso(NOW) : null,
      projectDir: dir,
      files: [path.join(dir, "bot.js")],
      skills: [],
      session: null,
    };
    agents.push(a);
  }
  Object.assign(a, {
    name: "העוזר האישי בוואטסאפ",
    kind: "assistant",
    kindLabel: "העוזר האישי",
    description: desc,
    project: "talbs-whatsapp-bot",
    folder: dir,
    type: "agent",
    typeLabel: TYPE_LABEL.agent,
    services: [{ name: "וואטסאפ", emo: "💬" }, { name: "Claude", emo: "✳️" }],
    links: [{ url: "http://127.0.0.1:7655", host: "127.0.0.1", label: "🖥️ המסך של העוזר" }],
    flow: buildFlow({
      trigger: { label: "הודעה שלך בוואטסאפ", emo: "💬" },
      main: { label: "העוזר האישי", sub: "רץ על המחשב", emo: "🤖" },
      chain: [{ label: "Claude Code", sub: "חושב ועונה", emo: "✳️" }],
      services: [{ name: "וואטסאפ", emo: "💬" }],
    }),
  });
  if (a.status === "off") return a;

  // דלוק זה לא מספיק: בודקים שהוא באמת מחובר לוואטסאפ (העוזר כותב status.json כל חצי דקה).
  const st = readJSON(path.join(dir, "status.json"), null);
  const fresh = st && Date.parse(st.updatedAt) > NOW - 3 * MIN;
  if (!fresh && a.status === "failed") {
    // התוכנה עצמה לא רצה: נשאר "נכשל" כמו שהמחשב דיווח.
  } else if (!fresh) {
    a.status = "unknown";
    a.statusWhy =
      "העוזר דלוק, אבל הגרסה שלו לא מדווחת אם הוא מחובר לוואטסאפ. כדאי לעדכן אותו";
    a.evidence = "המחשב מראה שהוא רץ";
  } else if (st.connected) {
    a.status = "ok";
    a.statusWhy = "דלוק ומחובר לוואטסאפ";
    a.evidence = "דיווח של העוזר עצמו";
    a.lastRun = st.updatedAt;
    saveAssistantState(null);
  } else if (/^(connecting|reconnecting|starting|green-settings|error)$/.test(st.status)) {
    // מתחבר: זה בסדר לכמה דקות. אם זה נמשך יותר מ-5 דקות, או שזה בא אחרי QR, זו תקלה.
    const ast = readJSON(ASSIST_STATE, {});
    const since = ast.badSince || NOW;
    saveAssistantState(since);
    if (NOW - since > 5 * MIN) {
      a.status = "failed";
      a.statusWhy = `העוזר לא מצליח להתחבר לוואטסאפ כבר ${Math.round((NOW - since) / MIN)} דקות`;
    } else {
      a.status = "unknown";
      a.statusWhy = "העוזר מתחבר כרגע לוואטסאפ";
    }
    a.evidence = "דיווח של העוזר עצמו";
  } else {
    const ast = readJSON(ASSIST_STATE, {});
    saveAssistantState(ast.badSince || NOW);
    a.status = "failed";
    a.statusWhy =
      st.status === "qr" || st.status === "needs-rescan"
        ? "העוזר דלוק אבל לא מחובר לוואטסאפ. צריך לסרוק QR מחדש במסך שלו"
        : /^green/.test(st.status)
          ? "העוזר דלוק, אבל החיבור ל-Green API לא מוגדר עד הסוף. פותחים את המסך שלו ומשלימים"
          : "יש תקלה בחיבור של העוזר לוואטסאפ. פותחים את המסך שלו כדי לראות מה קרה";
    a.evidence = "דיווח של העוזר עצמו";
  }
  return a;
}

// ---------- 6. תרחישי Make (הקובץ שהסקיל ממלא דרך החיבור ל-Make) ----------

// מקור 1: חיבור ישיר ל-Make עם מפתח קריאה (נשמר רק במחשב, ב-~/.ceo-agent/make.json).
// מקור 2: data/make.json ש-Claude ממלא דרך החיבור ל-Make (scan/make-import.mjs).
const MAKE_CFG = path.join(HOME, ".ceo-agent", "make.json");
const prettyApp = (p) =>
  String(p || "")
    .replace(/^app#/, "")
    .replace(/-[a-z0-9]{6}$/, "")
    .replace(/^builtin$/, "כלים")
    .replace(/^gateway$/, "וובהוק")
    .replace(/^util$/, "כלים")
    .replace(/[-_]/g, " ");

async function makeFetch(cfg, pathAndQuery) {
  const r = await fetch(`https://${cfg.zone}/api/v2${pathAndQuery}`, {
    headers: { Authorization: `Token ${cfg.token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Make ${r.status}`);
  return r.json();
}

async function makeFromApi() {
  const cfg = readJSON(MAKE_CFG, null);
  if (!cfg || !cfg.token || !cfg.zone || !cfg.teamId) return null;
  const list = await makeFetch(cfg, `/scenarios?teamId=${cfg.teamId}&pg[limit]=500`);
  const scenarios = list.scenarios || [];
  const since = NOW - 30 * DAY;
  await Promise.all(
    scenarios
      .filter((s) => s.islinked)
      .map(async (s) => {
        try {
          const logs = await makeFetch(
            cfg,
            `/scenarios/${s.id}/logs?from=${since}&pg[limit]=10&pg[sortDir]=desc&pg[sortBy]=imtId`,
          );
          const l = (logs.scenarioLogs || []).find((x) => x.status !== undefined && x.eventType !== "modify" && !["start", "stop", "modify"].includes(x.type));
          if (l) s._last = { status: l.status, at: l.timestamp || l.endedAt, operations: l.operations, error: l.error && l.error.message };
        } catch (e) {
          s._lastError = e.message;
        }
      }),
  );
  return { checkedAt: iso(NOW), zone: cfg.zone, teamId: cfg.teamId, scenarios };
}

function makeAgents(raw) {
  const agents = [];
  for (const s of raw.scenarios || []) {
    const linked = s.islinked !== undefined ? s.islinked : s.isActive !== false;
    const ex = s._last || s.lastExecution || null;
    const sched = (s.scheduling && s.scheduling.type) || s.trigger || "";
    const instant = sched === "immediately" || sched === "webhook";
    let status = "unknown", why = "";
    const invalid = s.isinvalid || s.isInvalid;
    // תרחיש ש-Make פסל: Make גם מכבה אותו לבד. אם הוא רץ בתקופה האחרונה, זו תקלה ולא "כבוי".
    if (invalid && (linked || s.executions > 0)) { status = "failed"; why = linked ? "Make סימן את התרחיש כלא תקין, ולכן הוא לא ירוץ" : "התרחיש כבוי, ו-Make מסמן אותו כלא תקין. הוא רץ בתקופה האחרונה, אז כדאי לבדוק אם כיבו אותו בכוונה"; }
    else if (!linked) { status = "off"; why = "התרחיש כבוי ב-Make"; }
    else if (s.isPaused) { status = "failed"; why = "Make עצר את התרחיש בגלל שגיאות"; }
    else if (s.dlqCount > 0) { status = "failed"; why = s.dlqCount === 1 ? "ריצה אחת נתקעה ומחכה לטיפול ב-Make" : `${s.dlqCount} ריצות נתקעו ומחכות לטיפול ב-Make`; }
    else if (!instant && s.nextExec && Date.parse(s.nextExec) < NOW - 30 * MIN) { status = "missed"; why = "היה אמור לרוץ לפי התזמון ב-Make, ועדיין לא רץ"; }
    else if (ex && (ex.status === 3 || /error|fail/i.test(String(ex.status)))) { status = "failed"; why = `הריצה האחרונה נכשלה${ex.error ? `: ${clean(ex.error, 120)}` : ""}`; }
    else if (ex && (ex.status === 2 || /warn/i.test(String(ex.status)))) { status = "ok"; why = "הריצה האחרונה עברה, עם אזהרה"; }
    else if (ex) { status = "ok"; why = "הריצה האחרונה הצליחה"; }
    else if (s.nextExec && Date.parse(s.nextExec) < NOW - 30 * MIN) { status = "missed"; why = "היה אמור לרוץ לפי התזמון ב-Make, ואין ריצה"; }
    else if (raw.checkedAt && s._last === undefined && s._lastError) { status = "unknown"; why = "לא הצלחתי לקרוא את היסטוריית הריצות מ-Make"; }
    else if (s._last === undefined && !s.lastExecution && !raw.fromApi && s.executions !== 0) { status = "unknown"; why = "אין מידע על הריצה האחרונה"; }
    else { status = "idle"; why = instant ? "פעיל ב-Make, ואין ריצות לאחרונה (מחכה למידע שיפעיל אותו). אי אפשר לדעת אם הוא תקין עד שירוץ" : "פעיל ב-Make, ואין ריצות לאחרונה. אי אפשר לדעת אם הוא תקין עד שירוץ"; }
    // מידע ישן מ-Make (יובא דרך Claude ולא נבדק ישירות): לא מציגים אותו כמצב של עכשיו.
    const age = raw.checkedAt ? NOW - Date.parse(raw.checkedAt) : Infinity;
    if (!raw.fromApi && status !== "off" && age > 2 * HOUR) {
      status = "unknown";
      why = `המידע מ-Make נבדק ${heWhen(Date.parse(raw.checkedAt))}, ולא ידוע מה קרה מאז. כדי לעדכן: "סוכן מנכ״ל, תסרוק"`;
    }
    const zone = raw.zone || "eu2.make.com";
    const team = s.teamId || raw.teamId;
    const mods = Array.isArray(s.usedModules) ? s.usedModules : Array.isArray(s.modules) ? s.modules : [];
    agents.push({
      id: `make:${s.id}`,
      name: clean(s.name, 90),
      sourceName: String(s.name || "").trim(),
      kind: "make",
      kindLabel: "תרחיש Make",
      where: "cloud",
      autonomous: sched !== "on-demand",
      schedule: sched === "immediately" ? "כשמגיע מידע" : sched === "indefinitely" ? "לפי מרווח קבוע" : sched === "daily" ? "פעם ביום" : sched === "weekly" ? "פעם בשבוע" : sched === "monthly" ? "פעם בחודש" : sched === "on-demand" ? "ידני" : "לפי התזמון ב-Make",
      status,
      statusWhy: why,
      evidence: raw.fromApi ? "לפי Make, בדיקה ישירה" : "לפי Make, דרך Claude",
      lastRun: ex && ex.at ? ex.at : null,
      description:
        clean(s.description || "", 200) ||
        [...new Set(mods.map((m) => prettyApp(m.packageName || m.app)).filter((x) => x && x !== "כלים"))]
          .slice(0, 6)
          .join(" ← "),
      project: s.folderPath || "Make",
      projectDir: null,
      files: [],
      url: team ? `https://${zone}/${team}/scenarios/${s.id}/edit` : null,
      type: mods.some((m) => /anthropic|claude|openai|chatgpt|gemini|ai-agent|ai-tools/i.test(m.packageName || m.app || "")) ? "combo" : "automation",
      typeLabel: "",
      services: detectServices(mods.map((m) => m.packageName || m.app || "").join(" ")),
      folder: s.folderPath ? `Make ← ${s.folderPath}` : "Make",
      flow: {
        chain: mods.slice(0, 16).map((m, i) => ({
          kind: i === 0 ? "trigger" : "step",
          label: clean(prettyApp(m.packageName || m.app), 30),
          sub: clean(String(m.moduleName || m.label || "").replace(/([a-z])([A-Z])/g, "$1 $2"), 50),
          emo: (detectServices(m.packageName || m.app || "")[0] || {}).emo || (i === 0 ? "⚡" : "⚙️"),
        })),
        branches: [],
      },
      skills: [],
      session: null,
    });
  }
  return agents;
}

async function scanMake() {
  let raw = null;
  let source = "";
  try {
    raw = await makeFromApi();
    if (raw) { raw.fromApi = true; source = "api"; }
  } catch (e) {
    raw = null;
    source = `api-error: ${e.message}`;
  }
  if (!raw) {
    const f = readJSON(path.join(DATA, "make.json"), null);
    if (f) { raw = f; source = source || "claude"; }
  }
  if (!raw) return { checked: false, agents: [], note: source };
  // תרחישים כבויים לא מוצגים כסוכנים (אצל רוב האנשים אלה ניסויים ישנים). רק סופרים אותם.
  const all = makeAgents(raw);
  return {
    checked: true,
    checkedAt: raw.checkedAt || null,
    fromApi: !!raw.fromApi,
    agents: all.filter((a) => a.status !== "off"),
    offCount: all.filter((a) => a.status === "off").length,
    note: source,
  };
}

// ---------- 7. סקילים שנבנו על ידי המשתמש = סוכנים ידניים ----------

// forced: סקילים שבעל העסק סימן כשלו, גם אם הותקנו מבחוץ
function manualAgents(skills, forced = new Set()) {
  return skills
    .filter((s) => s.name !== "ceo-agent" && path.basename(s.dir || "") !== "ceo-agent")
    .filter((s) => s.builtByUser || forced.has(`skill:${s.path}`))
    .map((s) => {
      const used = skillsMentioned(s.text, skills, s.name);
      const proj = s.scope === "project" ? s.projectDir : null;
      const services = detectServicesStrict(s.text).filter((x) => x.name !== "Claude");
      const combo = /hook\.[a-z0-9]+\.make\.com|make\.com\/[0-9]+\/scenarios|webhook/i.test(s.text || "");
      const trig = triggerPhrase(s.descriptionFull || s.description);
      return {
        id: `skill:${s.path}`,
        name: s.name,
        kind: "skill",
        kindLabel: "סוכן Claude Code",
        where: "computer",
        autonomous: false,
        schedule: "מפעילים כשצריך",
        status: "manual",
        statusWhy: "סוכן ידני: רץ רק כשמבקשים ממנו",
        evidence: "",
        lastRun: null,
        description: s.description,
        project: proj ? path.basename(proj) : "כל הפרויקטים",
        projectDir: proj || s.dir,
        folder: s.dir,
        files: [s.path],
        skills: used.map(skillCard),
        type: combo ? "combo" : "agent",
        typeLabel: TYPE_LABEL[combo ? "combo" : "agent"],
        services,
        links: detectLinks(s.text),
        _descFull: s.descriptionFull,
        flow: buildFlow({
          trigger: { label: trig ? `כותבים ל-Claude: "${trig}"` : "כותבים ל-Claude", emo: "💬" },
          main: { label: s.name, sub: "סוכן Claude Code", emo: "🤖" },
          skills: used.map(skillCard),
          services,
        }),
        session: s.session,
        sessionCwd: s.sessionCwd,
      };
    });
}

// סקילים בתיקיית עבודה עם "נקודת כניסה" = צוות אחד (כמו מחלקת הווידאו). סקיל כללי בלי תפקיד = כלי, לא סוכן.
const ENTRY_RE = /נקודת הכניסה|entry.?point|director|orchestrat|\bmanager\b|הסוכן המנהל/i;
const AGENT_RE = /סוכן|\bagent\b|\bbot\b|בוט|עוזר|מזכיר|אוטונומי/i;
function groupAgents(list) {
  const out = [];
  const byProject = {};
  for (const a of list) {
    const isProject = a.project && a.project !== "כל הפרויקטים";
    if (isProject) (byProject[a.projectDir] = byProject[a.projectDir] || []).push(a);
    else {
      const role = AGENT_RE.test(`${a.name} ${a.description} ${a._descFull || ""}`);
      out.push(role ? a : { ...a, type: "tool", typeLabel: "סקיל" });
    }
  }
  for (const [dir, group] of Object.entries(byProject)) {
    const main = group.find((g) => ENTRY_RE.test(`${g.name} ${g.description} ${g._descFull || ""}`));
    if (!main || group.length < 2) {
      out.push(...group);
      continue;
    }
    const team = group.filter((g) => g !== main);
    const services = [...new Map(group.flatMap((g) => g.services || []).map((x) => [x.name, x])).values()];
    const teamNames = new Set(team.map((t) => t.name));
    const skills = [...new Map(group.flatMap((g) => g.skills || []).filter((x) => !teamNames.has(x.name) && x.name !== main.name).map((x) => [x.name, x])).values()];
    out.push({
      ...main,
      id: `team:${dir}`,
      name: path.basename(dir),
      kind: "team",
      kindLabel: `צוות של ${group.length} סוכנים`,
      type: "agent",
      typeLabel: "סוכן",
      folder: dir,
      files: group.map((g) => g.files[0]),
      skills,
      services,
      flow: buildFlow({
        trigger: main.flow.chain[0],
        main: { label: main.name, sub: "הסוכן המנהל", emo: "🤖" },
        team: team.map((t) => ({ label: t.name, sub: t.description, emo: "🧩" })),
        skills,
        services,
      }),
    });
  }
  return out;
}

// ---------- 7ב. סוג, כלים ותזרים (רק ממה שכתוב בקבצים, בלי ניחושים) ----------

// במה הסוכן נוגע: מזהים לפי מה שכתוב בקבצים שלו או לפי המודולים ב-Make.
const SERVICES = [
  // רק סימנים טכניים חד-משמעיים (שמות כלים, כתובות, ספריות). מילה שמוזכרת בטקסט רגיל לא נחשבת.
  ["Claude", "✳️", /\bclaude\s+(-p|--print|--resume)\b|claude_bin|CLAUDE_BIN|@anthropic-ai|api\.anthropic/i],
  ["וואטסאפ", "💬", /green-?api|greenapi|baileys|whatsapp-web|wa\.me\/|\/messages\b.*whatsapp|whatsapp_business|talbs-whatsapp-bot\/outbox/i],
  ["Gmail", "📧", /\bgmail\b|mcp__claude_ai_Gmail|smtp\.[a-z]/i],
  ["יומן", "📅", /google.?calendar|calendar\.google|mcp__claude_ai_Google_Calendar|calendly/i],
  ["דרייב", "📁", /drive\.google|google.?drive|googledrive-|mcp__claude_ai_Google_Drive|DRIVE_[A-Z_]*\s*=/i],
  ["Google Sheets", "📊", /google.?sheets|docs\.google\.com\/spreadsheets|gspread/i],
  ["Airtable", "🗂️", /airtable/i],
  ["Make", "⚙️", /hook\.[a-z0-9]+\.make\.com|[a-z0-9]+\.make\.com\/|mcp__claude_ai_Make/i],
  ["זום", "🎥", /zoom\.us|mcp__claude_ai_Zoom|zoom_create|zoom api|\bzoom\b.*meeting/i],
  ["מטא", "📣", /graph\.facebook|mcp__claude_ai_meta|meta ads|ads manager|facebook ads/i],
  ["רב מסר", "✉️", /responder\.co|rav.?messer|רב.?מסר/i],
  ["Notion", "📓", /notion\.so|mcp__claude_ai_Notion/i],
  ["Monday", "📋", /monday\.com|mcp__claude_ai_monday/i],
  ["OpenAI", "🤖", /api\.openai|\bopenai\b|whisper/i],
  ["Telegram", "✈️", /api\.telegram|telegram/i],
  ["חשבונית ירוקה", "🧾", /greeninvoice|green.?invoice|morning\.co/i],
  ["TimeOS", "🎙️", /timeos|timeless/i],
];
// לסקילים (טקסט של הוראות): רק כלי MCP בשמם או כתובת API. אזכור של "meta ads" כדוגמה הוא לא חיבור.
function detectServicesStrict(text) {
  if (!text) return [];
  const t = String(text);
  const found = [];
  const add = (name, emo) => { if (!found.some((f) => f.name === name)) found.push({ name, emo }); };
  for (const m of t.matchAll(/mcp__(?:claude_ai_)?([A-Za-z0-9-]+)/g)) {
    const raw = m[1].replace(/_/g, " ");
    const hit = SERVICES.find(([, , re]) => re.test(raw)) ;
    add(hit ? hit[0] : raw, hit ? hit[1] : "🔌");
  }
  const hosts = [[/hook\.[a-z0-9]+\.make\.com|eu[12]\.make\.com\/api/i, "Make", "⚙️"], [/api\.airtable\.com/i, "Airtable", "🗂️"], [/graph\.facebook\.com/i, "מטא", "📣"], [/api\.green-api|green-api\.com/i, "וואטסאפ", "💬"], [/gmail\.googleapis/i, "Gmail", "📧"], [/googleapis\.com\/calendar/i, "יומן", "📅"], [/googleapis\.com\/drive/i, "דרייב", "📁"], [/api\.openai\.com/i, "OpenAI", "🤖"]];
  for (const [re, name, emo] of hosts) if (re.test(t)) add(name, emo);
  return found;
}
function detectServices(text) {
  if (!text) return [];
  return SERVICES.filter(([, , re]) => re.test(text)).map(([name, emo]) => ({ name, emo }));
}
// קישורים לדברים שהסוכן קשור אליהם (דף נחיתה, דרייב, טופס). בלי כתובות של מערכות פנימיות,
// ובלי שום פרמטר בכתובת, כדי שמפתחות לא ידלפו.
function detectLinks(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const m of String(text).matchAll(/https?:\/\/[^\s"'`<>)\]}{%]+/g)) {
    let u;
    try { u = new URL(m[0].replace(/[.,;:]+$/, "")); } catch { continue; }
    const h = u.hostname;
    let label = null;
    if (/\.vercel\.app$|\.netlify\.app$|\.github\.io$/i.test(h)) label = "🌐 דף";
    else if (/^docs\.google\.com$|^drive\.google\.com$/i.test(h)) label = "📁 דרייב";
    else if (/fillout\.com$|tally\.so$|typeform\.com$|^forms\.gle$/i.test(h)) label = "📝 טופס";
    if (!label) continue;
    u.search = "";
    u.hash = "";
    const clean = u.toString().replace(/\/$/, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, host: h, label });
    if (out.length >= 8) break;
  }
  return out;
}
const usesClaude = (t) => /\bclaude\b[^\n]{0,40}(-p\b|--print|--resume)|claude_bin|CLAUDE_BIN|["'`]claude["'`]|anthropic/i.test(t || "");
const TYPE_LABEL = { agent: "סוכן", combo: "שילוב", automation: "אוטומציה" };

// משפט ההפעלה הראשון מתוך התיאור של סקיל ("תבנה לי...", "סוכן מנכ״ל").
function triggerPhrase(desc) {
  const m = String(desc || "").match(/[""„"]([^""„"]{3,40})[""„"]/);
  return m ? m[1] : null;
}

// תזרים: שרשרת (מה מפעיל ← מה רץ) וענפים שתלויים בצומת האחרון (צוות, סקילים, כלים).
function buildFlow({ trigger, main, chain, team, skills, services }) {
  const nodes = [];
  if (trigger) nodes.push({ kind: "trigger", ...trigger });
  if (main) nodes.push({ kind: "main", ...main });
  if (chain) nodes.push(...chain.map((c) => ({ kind: "step", ...c })));
  const branches = [];
  if (team && team.length) branches.push({ title: "הצוות שלו", nodes: team.map((t) => ({ kind: "sub", ...t })) });
  if (skills && skills.length) branches.push({ title: "סקילים", nodes: skills.map((s) => ({ kind: "skill", label: s.name, sub: s.description })) });
  if (services && services.length) branches.push({ title: "נוגע ב", nodes: services.map((x) => ({ kind: "service", label: x.name, emo: x.emo })) });
  return { chain: nodes, branches };
}

// ---------- 7ג. צוותי סוכנים מתוך פלאגינים (כמו מנהל הקמפיינים) ----------
// פלאגין עם תיקיית agents = צוות סוכנים. פלאגינים מהחנות הרשמית של Anthropic הם כלי פיתוח, לא סוכנים של העסק.
function scanPlugins(skillIndex) {
  const reg = readJSON(path.join(HOME, ".claude", "plugins", "installed_plugins.json"), null);
  if (!reg) return [];
  const plugins = reg.plugins || reg;
  const out = [];
  for (const [key, installs] of Object.entries(plugins)) {
    try {
    if (/@claude-plugins-official$/.test(key)) continue;
    const inst = Array.isArray(installs) ? installs[0] : installs;
    const dir = inst && inst.installPath;
    if (!dir || !exists(path.join(dir, "agents"))) continue;
    const agentFiles = fs.readdirSync(path.join(dir, "agents")).filter((f) => f.endsWith(".md"));
    if (!agentFiles.length) continue;
    const meta = readJSON(path.join(dir, ".claude-plugin", "plugin.json"), {});
    const subs = agentFiles.map((f) => {
      const fm = parseFrontmatter(readHead(path.join(dir, "agents", f), 8000));
      return { label: fm.name || f.replace(/\.md$/, ""), sub: firstSentence(fm.description || ""), skills: Array.isArray(fm.skills) ? fm.skills : [] };
    });
    // הסקיל המנהל: זה שהתתי-סוכנים מוזכרים כמופעלים על ידו
    const skillDirs = exists(path.join(dir, "skills")) ? fs.readdirSync(path.join(dir, "skills")) : [];
    const allText = subs.map((x) => x.sub).join(" ") + " " + agentFiles.map((f) => readHead(path.join(dir, "agents", f), 4000)).join(" ");
    const mainSkill = skillDirs.find((d) => new RegExp(`\\b${d}\\b`).test(allText) && /manager|מנהל|orchestr|lead/i.test(d)) || skillDirs.find((d) => new RegExp(`\\b${d}\\b`).test(allText)) || skillDirs[0];
    const mainFile = mainSkill ? path.join(dir, "skills", mainSkill, "SKILL.md") : null;
    const mainFm = mainFile ? parseFrontmatter(readHead(mainFile, 8000)) : {};
    const usedSkills = [...new Set(subs.flatMap((x) => x.skills).map((x) => String(x).replace(/^[^:]+:/, "")))];
    const skillCards = usedSkills.map((n) => {
      const sf = path.join(dir, "skills", n, "SKILL.md");
      const fm = exists(sf) ? parseFrontmatter(readHead(sf, 8000)) : {};
      return { name: n, description: firstSentence(fm.description || ""), path: exists(sf) ? sf : dir };
    });
    const services = detectServices(allText + " " + (meta.description || "") + " " + (mainFm.description || ""));
    const niceName = (meta.description || "").split(/[:：]/)[0].trim();
    const name = niceName && niceName.length <= 40 ? niceName : meta.name || key.split("@")[0];
    const desc = firstSentence(mainFm.description || meta.description || "");
    out.push({
      id: `plugin:${key}`,
      name,
      kind: "plugin",
      kindLabel: `צוות של ${subs.length + 1} סוכנים`,
      type: "agent",
      typeLabel: TYPE_LABEL.agent,
      where: "computer",
      autonomous: false,
      schedule: "מפעילים כשצריך",
      status: "manual",
      statusWhy: "סוכן ידני: רץ רק כשמבקשים ממנו",
      evidence: "",
      lastRun: null,
      description: desc,
      project: key.split("@")[0],
      projectDir: dir,
      folder: dir,
      files: [mainFile].filter(Boolean),
      skills: skillCards,
      services,
      flow: buildFlow({
        trigger: { label: triggerPhrase(mainFm.description) ? `כותבים ל-Claude: "${triggerPhrase(mainFm.description)}"` : "כותבים ל-Claude", emo: "💬" },
        main: { label: mainSkill || name, sub: "הסוכן המנהל", emo: "🤖" },
        team: subs.map((x) => ({ label: x.label, sub: x.sub, emo: "🧩" })),
        skills: skillCards,
        services,
      }),
      session: null,
    });
      } catch (e) {
      // תוסף פגום פשוט לא מוצג, ולא עוצר את הסריקה
      continue;
    }
  }
  return out;
}

// ---------- 7ג2. החיבורים של Claude Code (מה שהעוזר האישי יכול להפעיל) ----------
// נלקח מ-"claude mcp list": רק מה שמסומן מחובר. בסריקה המהירה משתמשים בתוצאה האחרונה.
const CONNECTOR_EMO = [
  [/gmail/i, "📧"], [/calendar/i, "📅"], [/drive/i, "📁"], [/canva/i, "🎨"], [/\bmake\b/i, "⚙️"], [/airtable/i, "🗂️"],
  [/notion/i, "📓"], [/monday/i, "📋"], [/zoom/i, "🎥"], [/calendly/i, "🗓️"], [/meta|facebook/i, "📣"], [/vercel/i, "▲"],
  [/wordpress/i, "📝"], [/dropbox/i, "📦"], [/miro/i, "🧩"], [/higgsfield|heygen/i, "🎬"], [/messer|responder/i, "✉️"],
  [/timeless/i, "🎙️"], [/docs/i, "📄"], [/search|brave/i, "🔎"], [/memory/i, "🧠"], [/slack/i, "💬"], [/figma/i, "🎨"],
];
function claudeConnectors() {
  const cachePath = path.join(DATA, "connectors.json");
  const cached = readJSON(cachePath, null);
  if (QUICK && cached) return cached;
  const local = path.join(HOME, ".local", "bin", IS_WIN ? "claude.exe" : "claude");
  // בווינדוס, Claude שהותקן דרך npm הוא claude.cmd, ואותו מפעילים דרך cmd
  const out = exists(local)
    ? run(local, ["mcp", "list"], { timeout: 120000 })
    : IS_WIN
      ? run("cmd.exe", ["/d", "/s", "/c", "claude mcp list"], { timeout: 120000 })
      : run("claude", ["mcp", "list"], { timeout: 120000 });
  if (!out) return cached || { checked: false, list: [] };
  const list = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(.+?):\s.*-\s*✔\s*Connected/);
    if (!m) continue;
    const name = m[1].replace(/^claude\.ai\s+/i, "").replace(/^plugin:[^:]+:/i, "").replace(/^claude-\s*/i, "").trim();
    if (!name || list.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const emo = (CONNECTOR_EMO.find(([re]) => re.test(name)) || [null, "🔌"])[1];
    list.push({ name, emo });
  }
  const res = { checked: true, checkedAt: iso(NOW), list };
  fs.writeFileSync(cachePath, JSON.stringify(res));
  return res;
}

// ---------- 7ד. מדפים: סוכנים, רוטינות, מגירה ----------
// מה שמוצג נקבע לפי מה שבעל העסק באמת משתמש בו, ומה שהוא אישר. שום דבר לא נמחק: מה שלא מוצג נכנס למגירה עם סיבה.
function assistantName(a) {
  // עוזר וואטסאפ: בתיקייה שלו יש config.json עם agentName (גם העוזר של הסדנה וגם עוזרים אישיים)
  const dirs = [a.projectDir, a.folder, ...(a.files || []).map((f) => path.dirname(f))].filter(Boolean);
  for (const d of dirs) {
    const c = readJSON(path.join(d, "config.json"), null);
    if (c && c.agentName && (c.whitelist || c.provider || c.mode)) return { name: c.agentName, dir: d };
  }
  return null;
}
function hebrewName(a) {
  const n = String(a.name || "");
  if (/[\u0590-\u05FF]/.test(n)) return n;
  const d = String(a.description || "");
  if (/[\u0590-\u05FF]/.test(d)) {
    let t = d.split(/\s[—–-]\s|[:.(]|,\s/)[0].replace(/של טל בשור|של המשתמש|של בעל העסק/g, "").replace(/\s+/g, " ").trim();
    const words = t.split(" ");
    if (words.length > 6) t = words.slice(0, 6).join(" ");
    // לא לסיים שם במילת קישור ("גיבוי יומי של")
    t = t.replace(/(\s+(של|את|על|עם|אל|כל|או|גם|לכל|מכל|בכל|ל|ב|מ|ו|ה))+$/, "").trim();
    if (t.length >= 3 && /[\u0590-\u05FF]/.test(t)) return t;
  }
  return n.replace(/[-_]+/g, " ");
}
let ROSTER_BROKEN = false;
function shelve(agents) {
  const usage = skillUsage();
  const conn = claudeConnectors();
  const rosterFile = path.join(DATA, "roster.json");
  let roster = exists(rosterFile) ? readJSON(rosterFile, null) : { mine: [], notMine: [], added: [] };
  // רשימה פגומה: לא קורסים. מציגים בלי ההגדרות של המשתמש, ומדווחים (ראו sources)
  const okArr = (k) => roster[k] === undefined || Array.isArray(roster[k]);
  const okObj = (k) => roster[k] === undefined || (roster[k] && typeof roster[k] === "object" && !Array.isArray(roster[k]));
  ROSTER_BROKEN = exists(rosterFile) && (!roster || typeof roster !== "object" || !["mine", "notMine", "added"].every(okArr) || !["names", "roles", "goals"].every(okObj));
  if (ROSTER_BROKEN || !roster || typeof roster !== "object") roster = { mine: [], notMine: [], added: [] };
  const mine = new Set(roster.mine || []);
  const notMine = new Set(roster.notMine || []);
  const hasRoster = (roster.mine || []).length + (roster.notMine || []).length > 0;
  const W = usage.window;
  const use = (names) => {
    let best = { days: 0, last: null };
    for (const n of names) {
      const u = usage.by[n];
      if (u && u.days > best.days) best = { days: u.days, last: u.last };
    }
    return best;
  };
  for (const a of agents) {
    // עוזרי וואטסאפ: שם אמיתי, סוכן, ובדיקה שהם באמת פעילים
    // רק תוכנה שרצה ברציפות היא עוזר. סקריפט עזר באותה תיקייה (בדיקת בריאות, סיכום יומי) נשאר רוטינה.
    const continuous = a.id === "assistant" || a.kind === "assistant" || a.schedule === "פועל ברציפות" || a.schedule === "בכל כניסה למחשב";
    const as = a.kind !== "make" && continuous ? assistantName(a) : null;
    if (as) {
      a.kind = "assistant";
      a.kindLabel = "עוזר בוואטסאפ";
      a.type = "agent";
      a.name = as.name;
      a.description = "עוזר בוואטסאפ: כותבים לו מהטלפון, והוא עושה את העבודה דרך Claude Code וכל המערכות שמחוברות אליו.";
      a.folder = as.dir;
      // עוזר בוואטסאפ הוא Claude Code מלא: הוא יכול להפעיל כל מה שמחובר ל-Claude Code במחשב הזה.
      const extra = [{ name: "אינטרנט", emo: "🌐" }, { name: "קבצים ותוכנות במחשב", emo: "💻" }];
      a.services = [...conn.list, ...extra];
      a.flow = {
        chain: [
          { kind: "trigger", label: "הודעה שלך בוואטסאפ", emo: "💬" },
          { kind: "main", label: a.name, sub: "רץ על המחשב הזה", emo: "🤖" },
          { kind: "step", label: "Claude Code", sub: "חושב, מחליט ופועל", emo: "✳️" },
        ],
        branches: [
          {
            title: conn.checked
              ? `מחובר ל-${conn.list.length} מערכות (כל מה שמחובר ל-Claude Code אצלך), וגם לאינטרנט ולמחשב`
              : "אינטרנט ומחשב (את החיבורים של Claude Code לא הצלחתי לבדוק)",
            nodes: a.services.map((x) => ({ kind: "service", label: x.name, emo: x.emo })),
          },
        ],
      };
      // בלי דיווח חיבור (status.json): לפי הלוג שלו, אם התעדכן לאחרונה
      if (a.status === "ok" && !exists(path.join(as.dir, "status.json"))) {
        const logs = fs.readdirSync(as.dir).filter((f) => /\.log$/.test(f)).map((f) => mtime(path.join(as.dir, f)) || 0);
        const last = Math.max(0, ...logs);
        if (last > NOW - 6 * HOUR) { a.statusWhy = `פעיל: הלוג שלו התעדכן ${heWhen(last)}`; a.lastRun = iso(last); }
        else { a.status = "unknown"; a.statusWhy = last ? `התוכנה דלוקה, אבל לא כתבה כלום מאז ${heWhen(last)}` : "התוכנה דלוקה, ואין לוג שמראה שהיא פעילה"; }
      }
    }
    // שלושה מדפים כמו שבעל עסק חושב: סוכנים אוטונומיים (רצים לבד ויש בהם AI), סוכנים ידניים, ואוטומציות (בלי AI).
    const runner = a.kind === "scheduled" || a.kind === "make";
    const aiRunner = a.type === "combo" || (a.kind === "scheduled" && /סוכן|\bagent\b|המוח/i.test(`${a.description} ${a.name}`));
    if (a.kind === "assistant") {
      a.shelf = a.status === "off" ? "drawer" : "auto";
      if (a.status === "off") a.drawerReason = "מכובה";
    } else if (runner) {
      // כל מה שרץ לבד במחשב ועושה עבודה הוא סוכן אוטונומי (גם בלי AI). אוטומציות = תרחישים בענן (Make).
      a.shelf = a.status === "off" ? "drawer" : a.kind === "scheduled" || aiRunner ? "auto" : "automation";
      if (a.status === "off") a.drawerReason = "מכובה";
    } else {
      const names = [a.name, ...(a.flow && a.flow.chain ? a.flow.chain.filter((n) => n.kind === "main").map((n) => n.label) : [])];
      if (a.kind === "team" || a.kind === "plugin") for (const b of (a.flow.branches || [])) if (b.title === "הצוות שלו") names.push(...b.nodes.map((n) => n.label));
      const u = use(names);
      a.usage = { days: u.days, last: u.last, window: W };
      if (u.days >= 1) a.shelf = "manual";
      else {
        a.shelf = "drawer";
        a.drawerReason = `לא הופעל ב-${W} הימים האחרונים`;
      }
    }
    // סוכן שסימנת כשלך וכבוי: זו תקלה (הוא לא ירוץ), לא "לא בשימוש"
    if (mine.has(a.id) && a.status === "off") { a.status = "failed"; a.statusWhy = "סימנת שהוא שלך, אבל הוא כבוי ולא ירוץ. אם כיבו אותו בכוונה, אפשר להוציא אותו מהדשבורד."; a.evidence = "לפי מנהל המשימות של המחשב"; }
    if (mine.has(a.id)) { a.mine = true; if (a.shelf === "drawer") { a.shelf = runner ? (a.kind === "scheduled" || aiRunner ? "auto" : "automation") : "manual"; delete a.drawerReason; } }
    // שם בעברית: מה שבעל העסק קבע, ואם אין, מתוך התיאור
    if (roster.names && roster.names[a.id]) a.name = roster.names[a.id];
    else a.name = hebrewName(a);
    if (roster.roles && roster.roles[a.id]) a.description = a.role = roster.roles[a.id];
    if (roster.goals && roster.goals[a.id]) a.goal = roster.goals[a.id];
    if (notMine.has(a.id)) { a.shelf = "drawer"; a.drawerReason = "סומן: לא שלי"; }
    if (hasRoster && !mine.has(a.id) && !notMine.has(a.id) && a.shelf !== "drawer") a.isNew = true;
  }
  // נרשם ידנית ועכשיו נמצא (למשל תרחיש Make חדש שנמשך): מחברים אותו לסוכן האמיתי, בלי כפילות
  const addedLeft = [];
  for (const x of roster.added || []) {
    const hits = x.target ? matchAgents(agents, x.target) : [];
    if (hits.length === 1) {
      const a = hits[0];
      const aid = `added:${x.name}`;
      const pick = (k, v) => (roster[k] && roster[k][a.id]) ? null : (roster[k] && roster[k][aid]) || v;
      const nm = pick("names", x.name && x.name !== x.target ? x.name : "");
      const rl = pick("roles", x.role);
      const gl = pick("goals", x.goal);
      if (nm) a.name = nm;
      if (rl) a.description = a.role = rl;
      if (gl) a.goal = gl;
      a.mine = true;
      if (notMine.has(aid)) { a.shelf = "drawer"; a.drawerReason = "סומן: לא שלי"; }
      else if (a.shelf === "drawer" && !notMine.has(a.id)) { a.shelf = a.kind === "make" ? "automation" : a.kind === "scheduled" || a.kind === "assistant" ? "auto" : "manual"; delete a.drawerReason; }
      delete a.isNew;
    } else addedLeft.push(x);
  }
  // מה שאישרת ולא נמצא עכשיו: נשאר על המסך, לא נעלם בשקט
  const found = new Set(agents.map((a) => a.id));
  const prevAll = readJSON(path.join(DATA, "roster-names.json"), {});
  for (const id of mine) {
    if (found.has(id) || id.startsWith("added:")) continue;
    agents.push({ id, name: prevAll[id] || id, kind: "missing", kindLabel: "לא נמצא", type: "agent", shelf: "manual", where: "computer", autonomous: false, schedule: "—", status: "unknown", statusWhy: "נעלם מאז הבדיקה הקודמת. אולי הוא נמחק, הועבר או שונה לו השם", gone: true, description: "", files: [], skills: [], services: [], links: [], flow: { chain: [], branches: [] }, session: null });
  }
  for (const x of addedLeft) {
    const id = `added:${x.name}`;
    const role = (roster.roles && roster.roles[id]) || x.role || "";
    const hidden = notMine.has(id);
    agents.push({ id, name: (roster.names && roster.names[id]) || x.name, kind: "added", kindLabel: "נוסף ידנית", type: "agent", shelf: hidden ? "drawer" : x.routine ? "auto" : "manual", drawerReason: hidden ? "סומן: לא שלי" : undefined, where: x.where === "cloud" ? "cloud" : "computer", autonomous: !!x.routine, schedule: x.when || "—", status: "unknown", statusWhy: "רשום אצלך, אבל לא נמצא במחשב הזה או ב-Make, אז אין עליו מידע", description: role, role, goal: (roster.goals && roster.goals[id]) || x.goal || "", files: [], skills: [], services: [], links: [], flow: { chain: [], branches: [] }, session: null });
  }
  // שני סוכנים באותו שם (למשל גרסה ישנה וכבויה של אותו עוזר): הכבוי מקבל סימון, כדי שלא יתבלבלו ביניהם
  const byName = {};
  for (const a of agents) if (!a.gone) (byName[a.name] = byName[a.name] || []).push(a);
  for (const list of Object.values(byName)) {
    if (list.length < 2 || !list.some((a) => a.status !== "off")) continue;
    for (const a of list) if (a.status === "off" && !(roster.names && roster.names[a.id])) a.name = `${a.name} (גרסה כבויה)`;
  }
  // הבדיקה הקבועה של סוכן מנכ״ל עצמו: התפקיד והתוצאה ידועים מראש
  for (const a of agents) {
    if (a.id !== "launchd:com.ceo-agent.check" && a.id !== "task:CEO Agent Check") continue;
    if (!(roster.roles && roster.roles[a.id])) a.description = a.role = "בודק כל רבע שעה את כל הסוכנים, ושולח הודעה בוואטסאפ כשמשהו נתקע או לא רץ בזמן.";
    if (!(roster.goals && roster.goals[a.id])) a.goal = "הודעה בוואטסאפ על כל תקלה חדשה (פעם אחת), הודעה כשהיא נפתרת, וסיכום יומי אם ביקשת.";
  }
  // מי עוד צריך שם בעברית, תפקיד ותוצאה (הדשבורד ו-roster todo קוראים את אותו סימון)
  const he = (t) => /[\u0590-\u05FF]/.test(String(t || ""));
  for (const a of agents) {
    const own = (k) => roster[k] && (roster[k][a.id] || (a.kind === "added" && roster[k][a.id]));
    if ((a.shelf === "auto" || a.shelf === "manual") && !a.gone)
      a.needsDefinition = !a.goal || !(own("roles") || he(a.role || a.description)) || !(own("names") || he(a.name));
  }
  // שומרים שמות, כדי שאם משהו ייעלם נדע להציג את השם שלו
  const names = { ...prevAll };
  for (const a of agents) if (!a.gone) names[a.id] = a.name;
  fs.writeFileSync(path.join(DATA, "roster-names.json"), JSON.stringify(names));
  return usage;
}

// ---------- 8. קישור "פתח ב-Claude" ----------

const STATUS_HE = {
  ok: "תקין",
  partial: "חלקי",
  idle: "ממתין",
  failed: "נכשל",
  missed: "לא רץ בזמן",
  off: "מכובה",
  unknown: "לא ידוע",
  manual: "ידני",
};

function openPrompt(a) {
  const lines = [
    `אני רוצה לעבוד על הסוכן "${a.name}" (${a.kindLabel}).`,
    a.description ? `מה הוא עושה: ${a.description}` : "",
    a.files.length ? `הקבצים שלו: ${a.files.join(" , ")}` : "",
    a.url ? `התרחיש ב-Make: ${a.url}` : "",
    `סטטוס לפי סוכן מנכ״ל: ${STATUS_HE[a.status]}${a.statusWhy ? ` (${a.statusWhy})` : ""}.`,
    a.status === "failed" || a.status === "missed"
      ? "תבדוק מה קרה ותציע תיקון, ואל תשנה כלום לפני שאאשר."
      : "תקרא את הקבצים ותשאל אותי מה אני רוצה לשנות.",
  ].filter(Boolean);
  return lines.join("\n");
}

function attachLinks(a) {
  const prompt = openPrompt(a);
  a.openNew = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
  a.openSession = a.session
    ? `vscode://anthropic.claude-code/open?session=${encodeURIComponent(a.session)}`
    : null;
  // השיחה שמורה בתיקייה שבה היא התנהלה: צריך לפתוח קודם את התיקייה הזו ב-VS Code
  a.sessionDir = a.sessionCwd || null;
  delete a.sessionCwd;
}

// ---------- ריצה ----------

async function main() {
  const t0 = Date.now();
  const writes = QUICK
    ? readJSON(path.join(DATA, "sessions-index.json"), { writes: {} }).writes ||
      {}
    : buildSessionIndex();
  // הבדיקה הקבועה (--quick) לא עוברת שוב על כל תיקיות המחשב: היא משתמשת ברשימת הסקילים
  // מהסריקה המלאה האחרונה. ככה גם לא קופצות במק בקשות הרשאה לתיקיות מסמכים ושולחן העבודה.
  const SKILLS_CACHE = path.join(DATA, "skills-cache.json");
  let skills, manual;
  const cached = QUICK ? readJSON(SKILLS_CACHE, null) : null;
  if (cached) {
    // סקיל שנמחק מאז הסריקה המלאה האחרונה לא מוצג (בדיקת קיום של קובץ ידוע לא מקפיצה בקשת הרשאה)
    skills = (cached.skills || []).filter((x) => !x.path || exists(x.path));
    manual = (cached.manual || []).filter((a) => !(a.files || []).length || a.files.some((f) => exists(f)));
  } else {
    skills = scanSkills(writes);
    const rr = readJSON(path.join(DATA, "roster.json"), {}) || {};
    const forced = new Set(Array.isArray(rr.mine) ? rr.mine : []);
    manual = groupAgents(manualAgents(skills, forced));
    fs.writeFileSync(
      SKILLS_CACHE,
      JSON.stringify({ skills: skills.map(({ text, ...rest }) => rest), manual }),
    );
  }
  let agents = [];
  const sources = [];
  if (IS_MAC) {
    agents.push(...scanLaunchd(skills, writes));
    sources.push({ name: "משימות מתוזמנות במחשב", checked: true });
  }
  if (IS_WIN) {
    const w = scanWindowsTasks(skills, writes);
    agents.push(...w.agents);
    sources.push({ name: "משימות מתוזמנות במחשב", checked: w.checked });
  }
  scanAssistant(agents);
  const make = await scanMake();
  agents.push(...make.agents);
  sources.push({
    name: "תרחישי Make",
    checked: make.checked,
    offCount: make.offCount || 0,
    fromApi: !!make.fromApi,
    note: make.note || "",
    checkedAt: make.checkedAt,
  });
  agents.push(...manual.map((m) => ({ ...m })));
  agents.push(...scanPlugins(skills));
  sources.push({ name: "סוכני Claude Code", checked: true });

  shelve(agents);
  if (ROSTER_BROKEN) sources.push({ name: "הרשימה שלך (data/roster.json פגומה, אז השמות והתפקידים שהגדרת לא מוצגים)", checked: false });
  for (const a of agents) {
    if (!a.type) a.type = "automation";
    a.typeLabel = TYPE_LABEL[a.type];
    a.services = a.services || [];
    a.links = a.links || [];
    if (!a.flow) a.flow = { chain: [], branches: [] };
  }
  agents.forEach(attachLinks);
  const order = { failed: 0, partial: 1, missed: 2, unknown: 3, off: 4, ok: 5, idle: 6, manual: 7 };
  agents.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      b.autonomous - a.autonomous ||
      a.name.localeCompare(b.name, "he"),
  );

  const data = {
    scannedAt: new Date(NOW).toISOString(),
    root: ROOT,
    computer: os.hostname(),
    platform: process.platform,
    sources,
    totals: {
      auto: agents.filter((a) => a.shelf === "auto").length,
      manual: agents.filter((a) => a.shelf === "manual").length,
      automation: agents.filter((a) => a.shelf === "automation").length,
      drawer: agents.filter((a) => a.shelf === "drawer").length,
      found: agents.filter((a) => !a.gone && a.kind !== "added").length,
      autonomous: agents.filter((a) => a.autonomous).length,
      attention: agents.filter(
        (a) => a.status === "failed" || a.status === "missed" || a.status === "partial",
      ).length,
      skillsInstalled: skills.length,
    },
    agents,
  };
  fs.writeFileSync(
    path.join(DATA, "agents.json"),
    JSON.stringify(data, null, 1),
  );
  fs.writeFileSync(
    path.join(DATA, "agents.js"),
    `window.CEO_DATA = ${JSON.stringify(data)};\n`,
  );
  // ההגדרות (שם, התראות) עוברות לדשבורד בלי שום מפתח או סיסמה.
  const cfg = readJSON(path.join(DATA, "config.json"), null);
  if (cfg) {
    const safe = {
      ownerName: cfg.ownerName || "",
      businessName: cfg.businessName || "",
      alerts: cfg.alerts
        ? {
            enabled: !!cfg.alerts.enabled,
            daily: !!cfg.alerts.daily,
            instant: cfg.alerts.instant !== false,
            dailyAt: cfg.alerts.dailyAt || null,
            why: cfg.alerts.why || null,
          }
        : null,
      // הוכחה שההתראות באמת עובדות: מתי הבדיקה הקבועה רצה לאחרונה, והאם הייתה בעיה בשליחה.
      alertHealth: (() => {
        const h = readJSON(path.join(DATA, "alert-health.json"), null);
        return h ? { lastRunAt: h.lastRunAt || null, lastError: h.lastError || null } : null;
      })(),
    };
    fs.writeFileSync(path.join(DATA, "config.js"), `window.CEO_CONFIG = ${JSON.stringify(safe)};\n`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `נסרק תוך ${secs} שניות: ${data.totals.auto} סוכנים אוטונומיים, ${data.totals.manual} ידניים, ${data.totals.automation} אוטומציות, ${data.totals.drawer} לא בשימוש. ${data.totals.attention} נכשלו או לא רצו בזמן.`,
  );
  return data;
}

main().catch((e) => {
  console.error("הסריקה נכשלה:", e.message);
  process.exit(1);
});
