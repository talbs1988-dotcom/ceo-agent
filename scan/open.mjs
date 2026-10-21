#!/usr/bin/env node
// פותח דברים בצורה שעובדת בכל מחשב, בלי תלות בטרמינל (zsh, Git Bash, PowerShell או cmd).
//   node scan/open.mjs dashboard       פותח את הדשבורד בדפדפן
//   node scan/open.mjs make-connect    פותח חלון טרמינל לחיבור Make (המפתח מוקלד שם, לא בצ'אט)
// מדווח שנפתח רק אם הפקודה באמת הצליחה. אחרת נותן פקודה להריץ ידנית.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const what = process.argv[2] || "dashboard";
const ok = (r) => r && !r.error && r.status === 0;

if (what === "dashboard") {
  const file = path.join(ROOT, "dashboard", "index.html");
  const r =
    process.platform === "darwin"
      ? spawnSync("open", [file])
      : process.platform === "win32"
        ? spawnSync("cmd.exe", ["/c", `start "" "${file}"`], { windowsVerbatimArguments: true })
        : spawnSync("xdg-open", [file]);
  console.log(ok(r) ? `הדשבורד נפתח: ${file}` : `לא הצלחתי לפתוח. פותחים ידנית בדפדפן את הקובץ: ${file}`);
  process.exit(ok(r) ? 0 : 1);
} else if (what === "make-connect") {
  const script = path.join(ROOT, "scan", "make-connect.mjs");
  const manual = `"${process.execPath}" "${script}"`;
  let r = null;
  if (process.platform === "darwin") {
    const cmd = manual.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    r = spawnSync("osascript", ["-e", `tell application "Terminal" to do script "${cmd}"`, "-e", 'tell application "Terminal" to activate']);
  } else if (process.platform === "win32") {
    // cmd צריך את כל הפקודה כמחרוזת אחת עם מרכאות סביב הכול, כדי שנתיבים עם רווחים ועברית יעבדו
    r = spawnSync("cmd.exe", ["/c", `start "" cmd.exe /k "${manual}"`], { windowsVerbatimArguments: true });
  }
  if (ok(r)) console.log("נפתח חלון לחיבור Make. מדביקים שם את המפתח, ואז חוזרים לכאן.");
  else console.log(`לא הצלחתי לפתוח חלון. פותחים טרמינל ומריצים:\n${manual}`);
  process.exit(ok(r) ? 0 : 1);
} else {
  console.log("שימוש: node scan/open.mjs dashboard | make-connect");
}
