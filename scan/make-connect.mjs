#!/usr/bin/env node
// חיבור סוכן מנכ״ל ל-Make עם מפתח קריאה.
// רץ בטרמינל של המשתמש. המפתח מוקלד בלי שיופיע על המסך, נבדק מול Make,
// ונשמר רק במחשב: ~/.ceo-agent/make.json (הרשאות קריאה לבעלים בלבד).
// Claude לא רואה את המפתח בשום שלב.
//   node scan/make-connect.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const DIR = path.join(os.homedir(), ".ceo-agent");
const FILE = path.join(DIR, "make.json");
const ZONES = ["eu1.make.com", "eu2.make.com", "us1.make.com", "us2.make.com"];

function askHidden(q) {
  // מקלידים או מדביקים בלי שיופיע על המסך: מצב גולמי, ושום תו לא מוצג.
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buf.trim());
          return;
        }
        if (c === "\u0003") process.exit(1); // Ctrl+C
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else if (c >= " ") buf += c;
      }
    };
    stdin.on("data", onData);
  });
}
function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}
async function get(zone, token, p) {
  const r = await fetch(`https://${zone}/api/v2${p}`, {
    headers: { Authorization: `Token ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

console.log("\nחיבור סוכן מנכ״ל ל-Make\n");
console.log(
  "ב-Make: לוחצים על התמונה שלכם למטה ← Profile ← API access ← Add token.",
);
console.log(
  "מסמנים את ההרשאות: scenarios:read, organizations:read, teams:read, user:read",
);
console.log("מעתיקים את המפתח ומדביקים כאן. הוא לא יופיע על המסך, וזה בסדר.\n");

const token = await askHidden("המפתח: ");
if (!token) {
  console.log("לא הודבק מפתח. אפשר להריץ שוב בכל זמן.");
  process.exit(1);
}

let zone = null;
let netFail = 0;
for (const z of ZONES) {
  try {
    await get(z, token, "/users/me");
    zone = z;
    break;
  } catch (e) {
    // תשובה של Make (למשל 401) = המפתח לא התקבל. שגיאה בלי תשובה = בעיית אינטרנט
    if (!/^\d+$/.test(e.message)) netFail++;
  }
}
if (!zone && netFail === ZONES.length) {
  console.log("אין חיבור לאינטרנט, או ש-Make לא זמין כרגע. מנסים שוב בעוד רגע.");
  process.exit(1);
}
if (!zone) {
  console.log(
    "Make לא קיבל את המפתח. בודקים שהועתק במלואו ושסומנו ההרשאות, ומריצים שוב.",
  );
  process.exit(1);
}

let teamId = null;
try {
  const orgs = (await get(zone, token, "/organizations")).organizations || [];
  const teams = [];
  for (const o of orgs) {
    const t =
      (await get(zone, token, `/teams?organizationId=${o.id}`)).teams || [];
    for (const x of t) teams.push({ id: x.id, name: `${o.name} / ${x.name}` });
  }
  if (teams.length === 1) teamId = teams[0].id;
  else if (teams.length > 1) {
    teams.forEach((t, i) => console.log(`${i + 1}. ${t.name}`));
    let n = 0;
    while (!(n >= 1 && n <= teams.length)) n = Number(await ask(`באיזה צוות התרחישים שלכם? (מספר בין 1 ל-${teams.length}): `));
    teamId = teams[n - 1].id;
  }
} catch {}
if (!teamId) {
  console.log(
    "לא מצאתי צוות ב-Make. בודקים שסומנו ההרשאות organizations:read ו-teams:read.",
  );
  process.exit(1);
}

const scen = await get(zone, token, `/scenarios?teamId=${teamId}&pg[limit]=500`).catch(() => null);
if (!scen) {
  console.log("Make קיבל את המפתח, אבל לא נתן לקרוא את התרחישים. בודקים שסומנה ההרשאה scenarios:read, ומריצים שוב.");
  process.exit(1);
}
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(FILE, JSON.stringify({ token, zone, teamId }), { mode: 0o600 });
try {
  fs.chmodSync(FILE, 0o600);
} catch {}
console.log(`\nמחובר. נמצאו ${(scen.scenarios || []).length} תרחישים ב-Make.`);
console.log("אפשר לסגור את החלון ולחזור ל-Claude.\n");
