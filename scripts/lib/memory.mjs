/**
 * Long-term memory for M₳X: contacts, conversation episodes, world knowledge.
 * Stored as JSON in data/memory.json. The raw conversations live on the
 * observer (threads/thread), so this file can always be rebuilt.
 */

import fs from "node:fs";
import path from "node:path";
import { dataDir, log } from "./mc.mjs";

const file = path.join(dataDir, "memory.json");

const EMPTY = () => ({
  version: 1,
  contacts: {},   // agentId -> { name, profession, tags[], met, lastSeen, lastThread, summaries[] (newest last, max 5), notes[] }
  episodes: [],   // { at, threadId, otherId, name, summary, initiatedByMe } (max 500)
  world: {
    districts: {}, // id -> { name, visits, lastVisit, areas[], agentsSeen, notes[] }
    merchants: {}, // name -> { summary, spaceId, x, y, seenAt }
    facts: [],     // free-form strings with timestamps { at, text }
  },
  summarizedThreads: {}, // threadId -> true
});

export let memory = EMPTY();

export function load() {
  try {
    memory = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    memory = EMPTY();
  }
  for (const c of Object.values(memory.contacts)) c.name = cleanName(c.name);
  return memory;
}

export function save() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(memory, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    log("memory save failed:", e.message);
  }
}

export function contact(id) {
  if (!memory.contacts[id]) {
    memory.contacts[id] = { name: "", profession: "", tags: [], met: 0, lastSeen: 0, lastThread: "", summaries: [], notes: [] };
  }
  return memory.contacts[id];
}

/** Agent names that are really ids/hashes are not names we want to say out loud. */
export function cleanName(name) {
  if (!name) return "";
  const n = String(name).trim();
  if (/^[0-9a-f]{20,}$/i.test(n) || /^user-agent-/i.test(n) || n.length > 30) return "";
  return n;
}

export function noteContact(id, { name, profession, tags = [], threadId } = {}) {
  const c = contact(id);
  name = cleanName(name);
  if (name && !c.name) c.name = name;
  if (profession && !c.profession) c.profession = profession;
  for (const t of tags) if (!c.tags.includes(t)) c.tags.push(t);
  if (threadId && c.lastThread !== threadId) {
    c.met++;
    c.lastThread = threadId;
  }
  c.lastSeen = Date.now();
  return c;
}

export function addEpisode({ threadId, otherId, name, summary, initiatedByMe = false }) {
  if (memory.summarizedThreads[threadId]) return;
  memory.summarizedThreads[threadId] = true;
  memory.episodes.push({ at: Date.now(), threadId, otherId, name: name || "", summary, initiatedByMe });
  if (memory.episodes.length > 500) memory.episodes.splice(0, memory.episodes.length - 500);
  const c = contact(otherId);
  if (name && !c.name) c.name = name;
  c.summaries.push(summary);
  if (c.summaries.length > 5) c.summaries.splice(0, c.summaries.length - 5);
}

export function lastSummary(id) {
  const c = memory.contacts[id];
  return c && c.summaries.length ? c.summaries[c.summaries.length - 1] : "";
}

export function metBefore(id, currentThreadId) {
  const c = memory.contacts[id];
  if (!c) return false;
  return c.met > 1 || (c.met === 1 && c.lastThread !== currentThreadId) || c.summaries.length > 0;
}

export function district(id) {
  if (!memory.world.districts[id]) {
    memory.world.districts[id] = { name: id, visits: 0, lastVisit: 0, areas: [], agentsSeen: 0, notes: [] };
  }
  return memory.world.districts[id];
}

export function addFact(text) {
  if (memory.world.facts.some((f) => f.text === text)) return;
  memory.world.facts.push({ at: Date.now(), text });
  if (memory.world.facts.length > 200) memory.world.facts.splice(0, memory.world.facts.length - 200);
}

/** Compact text block about a contact, for prompts. */
export function contactBrief(id) {
  const c = memory.contacts[id];
  if (!c) return "";
  const bits = [];
  if (c.name) bits.push(`name: ${c.name}`);
  if (c.profession) bits.push(`profession: ${c.profession}`);
  if (c.tags.length) bits.push(`tags: ${c.tags.join(", ")}`);
  if (c.met) {
    const days = Math.floor((Date.now() - c.lastSeen) / 86400_000);
    const when = days <= 0 ? "earlier today" : days === 1 ? "yesterday" : `${days} days ago`;
    bits.push(`talked ${c.met}x, last time ${when}`);
  }
  if (c.summaries.length) bits.push(`previous conversations: ${c.summaries.slice(-2).map((s) => `"${s}"`).join(" | ")}`);
  return bits.join("; ");
}

/** Compact text block about the world, for prompts. */
export function worldBrief(max = 12) {
  const lines = [];
  for (const [id, d] of Object.entries(memory.world.districts)) {
    if (!d.visits) continue;
    lines.push(`${d.name || id}: visited ${d.visits}x${d.notes.length ? ", " + d.notes.slice(-2).join("; ") : ""}`);
  }
  for (const f of memory.world.facts.slice(-max)) lines.push(f.text);
  return lines.slice(-max).join("\n");
}

export function stats() {
  return {
    contacts: Object.keys(memory.contacts).length,
    named: Object.values(memory.contacts).filter((c) => c.name).length,
    episodes: memory.episodes.length,
    districtsVisited: Object.values(memory.world.districts).filter((d) => d.visits).length,
    facts: memory.world.facts.length,
  };
}
