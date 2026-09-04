/**
 * Daily report: what happened in the last 24 hours, written to
 * reports/YYYY-MM-DD.md, shown as a Windows notification, printable on demand.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { rootDir, dataDir, log } from "./mc.mjs";
import * as journal from "./journal.mjs";
import * as llm from "./llm.mjs";
import * as nightgate from "./nightgate.mjs";

const reportsDir = path.join(rootDir, "reports");

const fmtTime = (ms) => new Date(ms).toTimeString().slice(0, 5);
const fmtDur = (ms) => (ms < 3600_000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600_000).toFixed(1)} h`);

/** Collect the numbers for a window ending at `endMs` (default: now). */
export function collect(windowMs = 24 * 3600_000, endMs = Date.now()) {
  const from = endMs - windowMs;
  const ev = journal.since(from).filter((e) => e.at <= endMs);
  const by = (t) => ev.filter((e) => e.type === t);

  const batches = by("batch");
  const coinsSold = batches.reduce((a, e) => a + (e.sold || 0), 0);
  const crystalFromCoins = batches.reduce((a, e) => a + (e.earned || 0), 0);
  const meals = by("meal");
  const crystalForFood = meals.reduce((a, e) => a + (e.cost || 0), 0);
  const replies = by("reply");
  const openers = by("opener");
  const summaries = by("summary");
  const explores = by("explore");
  const sleeps = by("sleep");
  const errors = by("error");
  const shouts = by("shout");
  const attests = by("attest");
  const crystalPoints = by("crystal").sort((a, b) => a.at - b.at);
  const crystalStart = crystalPoints[0]?.value ?? null;
  const crystalEnd = crystalPoints.at(-1)?.value ?? null;
  const modes = by("mode").sort((a, b) => a.at - b.at);
  const modeTime = {};
  for (let i = 0; i < modes.length; i++) {
    const end = modes[i + 1]?.at ?? endMs;
    modeTime[modes[i].mode] = (modeTime[modes[i].mode] || 0) + (end - modes[i].at);
  }
  const people = new Map();
  for (const e of [...replies, ...openers, ...summaries]) {
    const k = e.name || e.otherId?.slice(-8) || "?";
    const p = people.get(k) || { name: k, replies: 0, openers: 0, summary: "" };
    if (e.type === "reply") p.replies++;
    if (e.type === "opener") p.openers++;
    if (e.type === "summary" && e.text) p.summary = e.text;
    people.set(k, p);
  }
  const l = llm.status();
  return {
    from, to: endMs, windowMs, events: ev.length,
    batches: batches.length, coinsSold, crystalFromCoins, crystalStart, crystalEnd,
    meals: meals.length, crystalForFood,
    replies: replies.length, openers: openers.length, shouts: shouts.length,
    conversations: summaries.length, people: [...people.values()],
    explores: explores.map((e) => ({ district: e.district, note: e.note, at: e.at })),
    sleeps: sleeps.map((e) => ({ at: e.at, minutes: e.minutes })),
    modeTime, errors: errors.map((e) => ({ at: e.at, text: e.text })),
    attests: attests.map((e) => ({ at: e.at, ok: e.ok, kind: e.kind, payloadHash: e.payloadHash, txHash: e.txHash, network: e.network, error: e.error })),
    llm: l,
  };
}

/** Plain-text/markdown report (German, like the rest of the project docs). */
export function render(d) {
  const lines = [];
  const day = new Date(d.to).toISOString().slice(0, 10);
  lines.push(`# M₳X – daily report ${day}`);
  lines.push(`Window: ${new Date(d.from).toLocaleString("en-GB")} – ${new Date(d.to).toLocaleString("en-GB")}`);
  lines.push("");
  lines.push("## Numbers");
  const delta = d.crystalStart != null && d.crystalEnd != null ? d.crystalEnd - d.crystalStart : null;
  lines.push(`- Crystal: ${d.crystalEnd ?? "?"}${delta != null ? ` (${delta >= 0 ? "+" : ""}${delta} in the window)` : ""}`);
  lines.push(`- Work: ${d.batches} batches, ${d.coinsSold} meme coins sold → +${d.crystalFromCoins} crystal`);
  lines.push(`- Meals: ${d.meals} (−${d.crystalForFood} crystal)`);
  lines.push(`- Conversations: ${d.conversations} finished, ${d.replies} replies, ${d.openers} started by M₳X, ${d.shouts} shouts`);
  lines.push(`- Explored: ${d.explores.length}× ${d.explores.map((e) => e.district).join(", ") || "–"}`);
  lines.push(`- Sleep: ${d.sleeps.length ? d.sleeps.map((s) => `${fmtTime(s.at)} (${s.minutes} min)`).join(", ") : "–"}`);
  const mt = Object.entries(d.modeTime).sort((a, b) => b[1] - a[1]).map(([m, ms]) => `${m} ${fmtDur(ms)}`).join(", ");
  if (mt) lines.push(`- Time split: ${mt}`);
  const anchored = d.attests?.filter((a) => a.ok) || [];
  const anchorFails = d.attests?.filter((a) => !a.ok) || [];
  if (anchored.length) {
    const byKind = {};
    for (const a of anchored) byKind[a.kind || "attest"] = (byKind[a.kind || "attest"] || 0) + 1;
    const parts = Object.entries(byKind).map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(", ");
    const a = anchored.at(-1);
    lines.push(`- On-chain proofs: ${anchored.length} anchored on Midnight ${a.network || "preprod"} (${parts}; latest tx ${a.txHash?.slice(0, 16)}…)`);
  }
  if (anchorFails.length) lines.push(`- On-chain proofs failed: ${anchorFails.length} (last: ${anchorFails.at(-1).error || "?"})`);
  const score = nightgate.scoreboard();
  if (score) lines.push(`- Prediction track record: ${score.evaluated} evaluated, ${score.within10} within 10%, avg error ${score.avgErrorPct}%${score.last ? ` (last: ${score.last.predicted} predicted vs ${score.last.actual} actual)` : ""}`);
  lines.push(`- LLM: ${d.llm.enabled ? `${d.llm.callsToday} calls today, ${d.llm.spentTodayUsd} / ${d.llm.budgetUsd} USD` : "off"}`);
  if (d.errors.length) lines.push(`- Errors: ${d.errors.length} (last ${fmtTime(d.errors.at(-1).at)}: ${d.errors.at(-1).text})`);
  if (d.people.length) {
    lines.push("");
    lines.push("## People");
    for (const p of d.people.slice(0, 15)) {
      lines.push(`- **${p.name}**${p.openers ? " (approached by M₳X)" : ""}${p.summary ? `: ${p.summary}` : ""}`);
    }
  }
  if (d.explores.length) {
    lines.push("");
    lines.push("## Out and about");
    for (const e of d.explores) lines.push(`- ${fmtTime(e.at)} ${e.district}: ${e.note || ""}`);
  }
  if (d.prose) {
    lines.push("");
    lines.push("## In short");
    lines.push(d.prose);
  }
  return lines.join("\n");
}

/** Optional 2-3 sentence prose from the LLM. */
export async function prose(d) {
  if (!llm.enabled()) return "";
  const facts = render({ ...d, prose: "" });
  const txt = await llm.plain(`Summarize the following daily report of the game agent M₳X (Midnight City) for his owner in 2-3 relaxed English sentences, written in third person about M₳X: what went well, what was new or notable, whether anything needs attention. No bullet points, no heading, just the sentences.\n\n${facts}`, 260, "report");
  return txt || "";
}

/** One-paragraph status line for the periodic push. `live` = { mode, coins, crystal, hunger, place }. */
export function renderStatus(d, live = {}) {
  const delta = d.crystalStart != null && d.crystalEnd != null ? d.crystalEnd - d.crystalStart : null;
  const hours = Math.round(d.windowMs / 3600_000);
  const bits = [
    `${live.crystal ?? d.crystalEnd ?? "?"} crystal${delta != null ? ` (${delta >= 0 ? "+" : ""}${delta} in ${hours}h)` : ""}`,
    `${live.coins ?? 0} coins in the bag`,
    `hunger ${live.hunger ?? "?"}`,
    `mode ${live.mode || "?"} at ${live.place || "?"}`,
  ];
  const acts = [];
  if (d.batches) acts.push(`${d.coinsSold} coins sold`);
  if (d.replies || d.openers) acts.push(`${d.replies} replies, ${d.openers} approaches`);
  if (d.conversations) acts.push(`${d.conversations} conversations`);
  if (d.explores.length) acts.push(`explored ${d.explores.map((e) => e.district).join(", ")}`);
  if (d.meals) acts.push(`${d.meals} meal${d.meals === 1 ? "" : "s"}`);
  if (d.sleeps.length) acts.push("slept");
  const okAttests = d.attests?.filter((a) => a.ok).length || 0;
  if (okAttests) acts.push(`${okAttests} proof${okAttests === 1 ? "" : "s"} anchored on Midnight`);
  if (d.errors.length) acts.push(`${d.errors.length} error${d.errors.length === 1 ? "" : "s"} (last: ${d.errors.at(-1).text.slice(0, 80)})`);
  const people = d.people.filter((p) => p.name && !/^[0-9a-f]{8}$/.test(p.name)).map((p) => p.name).slice(0, 6);
  return `${bits.join(" · ")}\nLast ${hours}h: ${acts.length ? acts.join("; ") : "quiet"}${people.length ? `\nTalked to: ${people.join(", ")}` : ""}\nLLM today: ${d.llm.enabled ? `${d.llm.spentTodayUsd} / ${d.llm.budgetUsd} USD` : "off"}`;
}

/** Send a short status push (webhook + mail if configured). */
export async function pushStatus(live = {}, windowMs = 3 * 3600_000) {
  const d = collect(windowMs);
  const text = renderStatus(d, live);
  const title = `M₳X status ${new Date().toTimeString().slice(0, 5)}`;
  await webhook(title, text);
  await email(title, text);
  log(`status push: ${text.split("\n")[0]}`);
  return text;
}

function toast(title, text) {
  if (process.platform !== "win32") return;
  const safe = (s) => String(s).replace(/'/g, "''").slice(0, 250);
  const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(20000, '${safe(title)}', '${safe(text)}', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 22; $n.Dispose()`;
  try {
    const child = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch (e) {
    log("toast failed:", e.message);
  }
}

/**
 * Push the report somewhere reachable from a server: MCITY_REPORT_WEBHOOK.
 * - https://ntfy.sh/<topic>  -> plain-text POST with a Title header (phone app / browser)
 * - Discord / Slack webhook   -> JSON { content, text }
 */
async function webhook(title, text) {
  const url = process.env.MCITY_REPORT_WEBHOOK;
  if (!url) return;
  try {
    let res;
    if (/ntfy\.sh|\/ntfy\//.test(url)) {
      // HTTP headers are Latin-1 only: "M₳X" -> "MAX"
      const asciiTitle = title.replace(/₳/g, "A").replace(/[^\x20-\x7e]/g, "");
      res = await fetch(url, { method: "POST", headers: { Title: asciiTitle, Markdown: "yes", Tags: "robot" }, body: text });
    } else {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text.slice(0, 1900), text }) });
    }
    log(`report webhook: ${res.status}`);
  } catch (e) {
    log("report webhook failed:", e.message);
  }
}

/**
 * E-mail the report. Config in .env:
 *   MCITY_REPORT_EMAIL_TO=max@example.com
 *   SMTP_URL=smtps://user:password@smtp.example.com:465   (or smtp://...:587 for STARTTLS)
 *   MCITY_REPORT_EMAIL_FROM=max-agent@example.com          (optional, defaults to the SMTP user)
 */
export async function email(subject, text) {
  const to = process.env.MCITY_REPORT_EMAIL_TO;
  const url = process.env.SMTP_URL;
  if (!to || !url) return false;
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transport = nodemailer.createTransport(url);
    const from = process.env.MCITY_REPORT_EMAIL_FROM || decodeURIComponent(new URL(url).username);
    const info = await transport.sendMail({ from: `"M₳X" <${from}>`, to, subject, text });
    log(`report mailed to ${to}: ${info.messageId || info.response || "ok"}`);
    return true;
  } catch (e) {
    log("report mail failed:", e.message);
    return false;
  }
}

/** Build, save, notify. Returns { file, text }. */
export async function generate({ windowMs = 24 * 3600_000, notify = true } = {}) {
  const d = collect(windowMs);
  d.prose = await prose(d);
  const text = render(d);
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, text + "\n");
  fs.writeFileSync(path.join(dataDir, "last-report.md"), text + "\n");
  // compact BEFORE the proof child starts - it re-reads the journal for this window
  // (a compaction racing the child once produced an all-zero anchored document)
  journal.compact();
  // real proof, not vibes: anchor the report on Midnight (detached child, no-op unless configured)
  if (notify) nightgate.attestReportAsync(file);
  if (notify) {
    const delta = d.crystalStart != null && d.crystalEnd != null ? d.crystalEnd - d.crystalStart : null;
    const short = d.prose || `${delta != null ? (delta >= 0 ? "+" : "") + delta + " crystal, " : ""}${d.coinsSold} coins sold, ${d.conversations} conversations, ${d.explores.length} exploration(s).`;
    toast("M₳X daily report", `${short} Details: reports\\${path.basename(file)}`);
    const subject = `M₳X daily report ${new Date().toISOString().slice(0, 10)}${delta != null ? ` (${delta >= 0 ? "+" : ""}${delta} Crystal)` : ""}`;
    await webhook(subject, text);
    await email(subject, text);
  }
  log(`report written: ${file}`);
  return { file, text };
}
