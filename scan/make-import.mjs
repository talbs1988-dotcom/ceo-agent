#!/usr/bin/env node
// ממיר את רשימת התרחישים ש-Claude משך דרך החיבור ל-Make (scenarios_list) לקובץ data/make.json.
// שימוש: node scan/make-import.mjs <קובץ-הרשימה.json> [zone] [teamId]
// אפשר להוסיף ריצות אחרונות: קובץ executions.json במבנה {"<scenarioId>": {status, at, operations}}.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [file, zone, teamId] = process.argv.slice(2);
if (!file) {
  console.error("חסר קובץ: node scan/make-import.mjs <scenarios.json> [zone] [teamId]");
  process.exit(1);
}
let list;
try {
  list = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error(`הקובץ ${file} לא נמצא או שהוא לא JSON תקין.`);
  process.exit(1);
}
if (!Array.isArray(list)) list = (list && list.scenarios) || [];
list = list.filter((s) => s && typeof s === "object");
const execFile = path.join(ROOT, "data", "make-executions.json");
let execs = {};
try {
  if (fs.existsSync(execFile)) execs = JSON.parse(fs.readFileSync(execFile, "utf8")) || {};
} catch {
  console.error("הקובץ data/make-executions.json פגום, ממשיכים בלי היסטוריית הריצות.");
}
const keep = ["id", "name", "teamId", "executions", "description", "folderPath", "islinked", "isinvalid", "isPaused", "dlqCount", "scheduling", "nextExec", "usedModules"];
const scenarios = list.map((s) => {
  const o = {};
  for (const k of keep) if (s[k] !== undefined) o[k] = s[k];
  if (execs[s.id]) o.lastExecution = execs[s.id];
  return o;
});
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "data", "make.json"),
  JSON.stringify({ checkedAt: new Date().toISOString(), zone: zone || "eu2.make.com", teamId: teamId ? Number(teamId) : null, scenarios }, null, 1),
);
console.log(`נשמרו ${scenarios.length} תרחישים (${scenarios.filter((s) => s.islinked).length} פעילים).`);
