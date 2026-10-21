#!/usr/bin/env node
// מדליק או מכבה את הבדיקה הקבועה של סוכן מנכ״ל (כל רבע שעה).
// מק: משימת launchd. ווינדוס: משימה במתזמן המשימות (רצה גם על סוללה, בלי חלון קופץ).
//   node alerts/schedule.mjs on
//   node alerts/schedule.mjs off
//   node alerts/schedule.mjs status
// "דלוקה" נאמר רק אחרי שהבדיקה באמת רצה וכתבה דוח, לא רק כי ההדלקה הצליחה.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const CHECK = path.join(ROOT, "alerts", "check.mjs");
const HEALTH = path.join(DATA, "alert-health.json");
const LOG = path.join(DATA, "check.log");
const LABEL = "com.ceo-agent.check";
const WIN_TASK = "CEO Agent Check";
const mode = process.argv[2] || "status";
fs.mkdirSync(DATA, { recursive: true });

const run = (cmd, args) => {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      }),
    };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message) };
  }
};
const xml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const healthAt = () => {
  try {
    return (
      Date.parse(JSON.parse(fs.readFileSync(HEALTH, "utf8")).lastRunAt) || 0
    );
  } catch {
    return 0;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// מצב הבדיקה במילים, לפי הדוח שהיא כותבת (ולא רק לפי זה שהיא "טעונה").
function describe(loaded) {
  if (!loaded) return "כבויה";
  let h = {};
  try { h = JSON.parse(fs.readFileSync(HEALTH, "utf8")); } catch {}
  if (h.disabled) return "המשימה דלוקה, אבל ההתראות כבויות בהגדרות";
  const age = Date.now() - (Date.parse(h.lastRunAt) || 0);
  if (age > 45 * 60 * 1000) return "דלוקה, אבל לא רצה ב-45 הדקות האחרונות";
  if (h.lastError) return `דלוקה ורצה, אבל יש בעיה: ${h.lastError}`;
  return "דלוקה ורצה";
}

// מחכים עד דקה שהבדיקה תרוץ פעם אחת ותכתוב דוח.
async function waitForFirstRun(since) {
  for (let i = 0; i < 30; i++) {
    if (healthAt() > since) return true;
    await sleep(2000);
  }
  return false;
}
function report(ok) {
  if (ok) {
    let h = {};
    try {
      h = JSON.parse(fs.readFileSync(HEALTH, "utf8"));
    } catch {}
    console.log(
      h.lastError
        ? `הבדיקה הקבועה רצה, אבל יש בעיה: ${h.lastError}`
        : "הבדיקה הקבועה דלוקה ורצה. מעכשיו היא בודקת כל רבע שעה.",
    );
    process.exit(h.lastError ? 2 : 0);
  }
  let tail = "";
  try {
    tail = fs.readFileSync(LOG, "utf8").split("\n").slice(-6).join("\n");
  } catch {}
  console.log(`הבדיקה הודלקה, אבל עוד לא רצה. כדאי לבדוק את הלוג:\n${tail}`);
  process.exit(1);
}

if (process.platform === "darwin") {
  const plist = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LABEL}.plist`,
  );
  const domain = `gui/${process.getuid()}`;
  if (mode === "on") {
    const envPath = [
      path.dirname(process.execPath),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":");
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(CHECK)}</string></array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string></dict>
</dict>
</plist>
`,
    );
    const since = healthAt();
    run("launchctl", ["bootout", `${domain}/${LABEL}`]);
    const r = run("launchctl", ["bootstrap", domain, plist]);
    if (!r.ok && !run("launchctl", ["print", `${domain}/${LABEL}`]).ok) {
      console.log(`לא הצלחתי להדליק: ${r.out.trim()}`);
      process.exit(1);
    }
    report(await waitForFirstRun(since));
  } else if (mode === "off") {
    run("launchctl", ["bootout", `${domain}/${LABEL}`]);
    try {
      fs.unlinkSync(plist);
    } catch {}
    const still = run("launchctl", ["print", `${domain}/${LABEL}`]).ok;
    console.log(still ? "לא הצלחתי לכבות. המשימה עדיין טעונה." : "הבדיקה הקבועה כבויה.");
    process.exit(still ? 1 : 0);
  } else {
    const p = run("launchctl", ["print", `${domain}/${LABEL}`]);
    console.log(describe(p.ok));
  }
} else if (process.platform === "win32") {
  if (mode === "on") {
    // עוטפים ב-VBS כדי שלא יקפוץ חלון שחור כל רבע שעה. נשמר ב-UTF-16 כדי ששמות בעברית יעבדו.
    const vbs = path.join(DATA, "check.vbs");
    const q = (s) => s.replace(/"/g, '""');
    const cmd = `cmd /c chcp 65001>nul & ""${q(process.execPath)}"" ""${q(CHECK)}"" >> ""${q(LOG)}"" 2>&1`;
    fs.writeFileSync(
      vbs,
      "﻿" + `CreateObject("WScript.Shell").Run "${cmd}", 0, True\r\n`,
      "utf16le",
    );
    const ps = `
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbs.replace(/'/g, "''")}"' -WorkingDirectory '${ROOT.replace(/'/g, "''")}'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName '${WIN_TASK}' -Action $a -Trigger $t -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskName '${WIN_TASK}'`;
    const since = healthAt();
    const r = run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      ps,
    ]);
    if (!r.ok) {
      console.log(`לא הצלחתי להדליק: ${r.out.trim()}`);
      process.exit(1);
    }
    report(await waitForFirstRun(since));
  } else if (mode === "off") {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Unregister-ScheduledTask -TaskName '${WIN_TASK}' -Confirm:$false`,
    ]);
    const still = run("schtasks", ["/Query", "/TN", WIN_TASK]).ok;
    console.log(still ? "לא הצלחתי לכבות. המשימה עדיין קיימת." : "הבדיקה הקבועה כבויה.");
    process.exit(still ? 1 : 0);
  } else {
    const p = run("schtasks", ["/Query", "/TN", WIN_TASK]);
    console.log(describe(p.ok));
  }
} else {
  console.log("המערכת הזו עדיין לא נתמכת. נתמכים: מק וווינדוס.");
  process.exit(1);
}
