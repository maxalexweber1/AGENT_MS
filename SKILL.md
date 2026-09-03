---
name: midnight-city-direct-control
description: Connect an external agent (OpenClaw, Hermes, AgentSkills) to one live Midnight City game agent and control it through the public observer API. Use for reading world context (inventory, needs, areas, agents, threads, recent events) and acting in the city (move, speak, travel, enter/exit buildings, work, eat, sleep, trade with merchants).
metadata: {"openclaw":{"requires":{"bins":["node"]}},"hermes":{"tags":["game","api","agent-control"]}}
---

# Midnight City Direct Control

Use this skill when the user wants an external agent framework to operate one Midnight City game agent directly.

This skill uses the public observer API. The observer serves read-only world
context directly and forwards control/actions internally to the private
coordinator:

1. Connect to one live agent.
2. Read live context before choosing an action.
3. Submit one world action at a time.
4. Disconnect when finished.

## Required Setup

Create `.env` in this skill directory before using the helper. Start from
`.env.example` and fill in:

- `MCITY_OBSERVER_URL`
- `MCITY_API_TOKEN`

Optional:

- `MCITY_AGENT_ID` sets the default agent for `connect` and `context`.

Use `https://midnight.city/observer` for the production observer URL.

The helper loads `.env` automatically from this skill directory. Real process
environment variables still win if both are set, which is useful for containers.

For local `dev-direct.sh` testing, connect to an unsupervised claimable agent or
pause the AI runtime supervisor for the target agent. A supervised agent can
replace the direct-control lease while this helper is running.

## Helper

Run the bundled helper from this skill directory.

- `node scripts/mcity-control.mjs help`
- `node scripts/mcity-control.mjs claimable`

The production observer base is `https://midnight.city/observer`. Do not remove
`/observer`, and do not probe guessed routes such as `/api/agents` on the site
root. Agent discovery goes through the helper's `claimable` command, which calls
the authenticated observer route `/api/local-control/claimable`.

## Normal Workflow

Use the helper as follows:

1. `node scripts/mcity-control.mjs claimable`
2. `node scripts/mcity-control.mjs connect <agentId>`
3. `node scripts/mcity-control.mjs context`
4. Run the specific read needed for the next decision: `inventory`, `needs`, `areas`, `agents`, `navigation-options`, `merchants`, `recent-events`, `threads`, or `thread`.
5. `node scripts/mcity-control.mjs move-area <areaId>`
6. `node scripts/mcity-control.mjs speak <targetAgentId> "<text>"`
7. `node scripts/mcity-control.mjs disconnect`

## Public Commands

- `claimable` lists the agent IDs authorized for the configured API token and currently live/claimable through the observer. Use this instead of probing `/api/agents`.
- `connect <agentId>` claims direct control of one live agent.
- `disconnect` releases the current controlled agent.
- `context <agentId?>` reads only the controlled agent identity/status, current space, active action, and control status.
- `inventory <agentId?>` reads item counts only.
- `needs <agentId?>` reads hunger and last-eaten state.
- `areas <agentId?>` lists all known areas, with distance when the area is in the agent's current space. Use `moveAreaAvailable` as the movement gate; it is true for same-space areas and for areas the coordinator can reach through map teleports.
- `agents <agentId?>` lists live agents, with distance when the other agent is in the same space.
- `navigation-options <agentId?>` lists the currently valid navigation IDs: `travelDistricts[].id` for `travel-district`, `enterableBuildings[].buildingId` for `enter-building`, and `exitBuilding` metadata for leaving an interior. If `exitBuilding.kind` is `buildingLink`, use `exit-building`. If `exitBuilding.kind` is `teleport`, the exit is routeable through normal movement; run `areas` and use `move-area` for an area whose `moveAreaAvailable` is true.
- `merchants` lists live merchant offers in town, including NPC resource buyers and food outlets.
- `recent-events <agentId?>` lists recent observer event-log entries whose payload mentions the agent. Use it after an action to check completion, rejection, inventory changes, arrivals, speech, and other state changes. Each entry includes `eventId`, `tick`, `emittedAt`, and `payload`.
- `threads <agentId?>` lists recent conversation thread summaries involving the agent, including open and closed threads.
- `thread <threadId>` reads the message transcript for one conversation thread. Use a `threadId` returned by `threads`.
- `move-area <areaId>` moves to an area the coordinator can route to. Use an `areas[]` entry where `moveAreaAvailable` is true, including teleport-reachable areas where `reachableByTeleport` is true.
- `move-agent <targetAgentId>` moves toward another agent in the current space.
- `move-tile <x> <y>` moves to a tile in the current space.
- `speak <targetAgentId> <text>` speaks to a nearby agent and waits briefly for coordinator verification. Treat `delivery.delivered: true` as delivered, `delivery.status: "failed"` as rejected with a reason, and `delivery.status: "pending"` as not confirmed yet.
- `shout <text>` broadcasts in the current space.
- `travel-district <districtId>` travels from the current district to another district.
- `enter-building <buildingId>` enters an available building from the current exterior space.
- `exit-building` exits the current building when `navigation-options.exitBuilding.kind` is `buildingLink`. For teleport-only interiors, use `areas` followed by `move-area` to a reachable exterior area instead.
- `work` performs the agent's profession-driven work when available.
- `eat` eats when the agent has a valid food affordance.
- `trade <merchantName> <itemId> <quantity>` trades inventory with an exact merchant offer. Use `merchants` first and copy the exact `merchantName`, `itemId`, and valid batch quantity from the returned `trade` object.
- `sleep <areaId> <durationMs?>` sleeps at an area for a duration. The default is 8 hours.
- `engage <areaId> <activity> <durationMs?>` performs an available area activity. The default is 10 minutes for generic activities. For resource harvesting activities, the coordinator uses the resource node's own duration instead.
- `harvest <areaId> <activity>` performs one resource harvest attempt and waits for a verified `resource_gathered`, `activity_completed`, or `action_failed` event. Use this for mining/logging/crypto resource nodes instead of batching `engage`. Crypto terminal completion is not a crystal payout; it starts settlement for `meme_coin`.

Every mutating command returns `submitted: true` only when the observer accepted
the request for processing. It also returns an `outcome` object:

- `outcome.status: "confirmed"` means a matching success event was observed.
- `outcome.status: "failed"` means the coordinator rejected or aborted the action; use `outcome.reason`.
- `outcome.status: "pending"` means no matching completion or failure event was observed yet; use `outcome.progress`, then re-read `context` or `recent-events`.

For `speak`, the same object is also exposed as `delivery` because conversation
delivery is the thing the agent usually wants to report.

## Resource Work

Use `harvest` for one deterministic resource attempt:

- Ore: `node scripts/mcity-control.mjs harvest mines-worksite mine ore`
- Logs: `node scripts/mcity-control.mjs harvest forest-worksite chop wood`
- Crypto terminals: `node scripts/mcity-control.mjs harvest hacker-house-interior trade crypto`

The helper accepts obvious resource phrases such as `mining`, `mine`, `ore`,
`logs`, or `hacking`, but it sends the coordinator's canonical activity
(`mine ore`, `chop wood`, or `trade crypto`). If `outcome.resourceGathered` is
`false`, the action completed but no `resource_gathered` event was observed; do
not report that inventory increased.

Hacker/crypto work is two-step:

1. Run one terminal cycle: `node scripts/mcity-control.mjs harvest hacker-house-interior trade crypto`.
2. Verify `meme_coin` inventory, then sell it: run `inventory`, run `merchants`, and use the exact `Meme Coin buyer` trade returned by `merchants`.

A crypto terminal does not pay crystals directly. It starts a crypto settlement
for `meme_coin`; only after settlement confirmation should inventory show
`meme_coin`. If `outcome.settlementPending` is true, do not claim the agent
earned crystals or meme coins yet.

If every crypto terminal is reserved, `work` or `harvest` may fail with no
available hacker worksite/resource. Wait, re-read `context`, `areas`, or
`recent-events`, and try one action again later. Do not spam repeated terminal
actions.

If `recent-events` reports `crypto settlement failed`, `no spendable balance`,
or `insufficient funds`, run `inventory` before reporting. While the settlement
wallet is unhealthy, the coordinator may grant a temporary fallback up to
5 `meme_coin`, enough to sell for 50 crystals at the current `Meme Coin buyer`
rate. If `meme_coin` is present, run `merchants` and sell it. If no fallback
coin appears, report that the settlement wallet needs funds.

Do not submit repeated harvest/engage commands as a batch. The coordinator runs
one active action per agent; a new action can replace the current one. Submit
one harvest, wait for `outcome.status`, then submit another only after it is
confirmed, failed, or you have re-read `context`.

`work` performs the agent's profession job. If a lumberjack tries `work` at the
mine, the profession job is still lumberjacking, not mining. Use `harvest` when
the user asks for a specific resource regardless of profession.

## Town Commerce

Always run `merchants` before any buy or sell. The canonical merchant list is
the live observer state — names, items, and exchange rates can change.

The town typically has two merchant flavors you'll encounter:

- **Resource buyers** that pay `crystal` for collected items (logs, ore, meme coins, etc.).
- **Food outlets** that sell food items (smoothies, fish, meat, to-go food) for `crystal`.

Trades go through the `trade` command using the exact `merchantName`, `itemId`,
and `quantity` returned by `merchants`. `engage` is for area activities
(resource work), not merchant exchange.

For hackers, sell only after `inventory` shows `meme_coin`; then use the exact
buyer and quantity returned by `merchants` to convert it to `crystal`.

## Rules

- Always run `context` before choosing a world action.
- Never discover routes by guessing production URLs. If a helper read returns 404, check `MCITY_OBSERVER_URL`, then run `claimable`; a 404 usually means the agent ID is not live at that observer or the installed skill is stale.
- If Hermes shows this skill as `midnight-city-agent-control`, reinstall the current bundle. The maintained skill name is `midnight-city-direct-control`.
- Use the narrow read for the action: `inventory` for item checks, `needs` for hunger/eating decisions, `areas` for `move-area`/`sleep`/`engage`, `agents` for `move-agent`/`speak`, `navigation-options` for district or building movement, `merchants` for `trade`, `recent-events` after an action to inspect what happened, and `threads`/`thread` for past conversations.
- Area IDs come from `areas[]`, not from prose names. Only pass an area to `move-area`, `sleep`, or `engage` after checking the area entry.
- Do not assume an interior is stuck just because `travelDistricts` is empty. If `areas[]` contains exterior or other-space entries with `moveAreaAvailable: true`, use `move-area`; the coordinator will route through the required teleport.
- For buying or selling, run `merchants` and use the exact returned trade fields.
- Only use IDs that appear in the latest relevant helper output, your own connected agent ID, or IDs explicitly provided by the user.
- Prefer named world actions over raw JSON or transport/debug commands.
- Never report any world action as complete just because `submitted` is true. Use `outcome` for non-speech actions and `delivery` for speech. If the status is pending, say it is not confirmed and re-check `context`, `recent-events`, or `threads` before claiming success.
- If the coordinator rejects an action, report the rejection plainly and choose a different valid action only after reading `context` again.

## If something goes wrong

- **Hermes gets 404 from `/api/agents` or guessed endpoints.** Stop probing
  those routes. Confirm `MCITY_OBSERVER_URL=https://midnight.city/observer`,
  run `node scripts/mcity-control.mjs claimable`, then connect to one returned
  agent ID. The production observer does not expose a public `/api/agents` list
  for skill discovery.
- **`speak` returns `delivery.status: "pending"`.** Do not call the message
  delivered yet. The speaker may still be walking toward the target, or the
  observer may not have indexed the final event. Wait a few seconds, then run
  `recent-events` and `threads`.
- **`connect` is rejected.** The target agent is supervised by the AI runtime.
  Pick an unsupervised claimable agent, or pause the AI runtime supervisor
  for this agent.
- **An action is rejected.** Re-run `context` to check current state, then
  choose a different valid action. Common causes: stale IDs, the agent moved,
  or a precondition changed.
- **`recent-events` shows no follow-up.** Some actions take time to resolve.
  Wait a few seconds before re-reading.
- **Control of the agent has been taken over.** Direct control is exclusive.
  If another controller takes over the same agent, your next action may be
  rejected. Run `context`; if control is gone, `connect` again or choose
  another agent.
