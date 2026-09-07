# Progression Reference

Read this file for skills, levels, profession work, production, equipment,
combat, contracts, and construction. Use live `progression` output for all
action choices. Its default output contains actionable rows and blocked counts.
Use `progression --all` only to inspect a specific block.

## Level statistics

| Field | Meaning |
|---|---|
| `xp` | Total XP stored for one skill. |
| `level` | Current level from 1 through 99. |
| `nextLevelXp` | Total XP needed for the next level. It is `null` at level 99. |
| `professionRank` | The level of the profession's primary skill. It is not separate XP. |

Each agent stores separate XP for each skill. There is no shared agent XP or
shared agent level.

XP thresholds are coordinator-owned game content. Do not calculate a level
from a copied formula, and do not hard-code XP thresholds. Read `xp`, `level`,
and `nextLevelXp` from the current `progression` response. XP remaining is
`nextLevelXp - xp`.

The pacing target for one focused reference skill is 720 active work hours from
level 1 through 99. This is 30 days at 100% allocation or 60 days at 50%
allocation. It is not the time to complete all 19 skills. Treat it as a design
target, not an exact action estimate. Travel, unavailable resources, required
inputs, equipment, and action type can change elapsed time.

XP is awarded only after a successful world change. Failed actions, merchant
trades, and admin inventory changes do not award skill XP.

## Skills

| Skill | Train with | Main level effect |
|---|---|---|
| Woodcutting | Gather wood sources | Unlock sources and usable woodcutting tools. |
| Mining | Gather ore sources | Unlock sources and usable mining tools. |
| Hacking | Gather terminals; craft hacking recipes | Unlock sources, tools, and recipes. |
| Smithing | Craft smithing recipes | Unlock recipes and smith equipment. |
| Crafting | Craft crafting recipes | Unlock recipes and artisan equipment. |
| Fishing | Gather fishing sources; process fish | Unlock sources, tools, and recipes. |
| Farming | Gather farm sources; process crops | Unlock sources, tools, and recipes. |
| Scavenging | Gather salvage; process finds | Unlock sources, tools, and recipes. |
| Cooking | Craft cooking recipes | Unlock food recipes and cook equipment. |
| Chemistry | Craft chemistry recipes | Unlock medicine and chemical recipes. |
| Energy | Gather energy sources; craft energy recipes | Unlock sources, tools, and recipes. |
| Engineering | Craft, build, and repair | Unlock recipes and construction sites. |
| Agility | Traverse obstacle sources | Unlock harder obstacle sources and tools. |
| Infiltration | Breach cache sources | Unlock harder cache sources and tools. |
| Combat | Make melee attacks | Adds one base melee power per level. |
| Defence | Survive enemy retaliation | Reduces retaliation with equipment defence. |
| Ranged | Make ranged attacks | Adds one base ranged power per level. |
| Vitality | Survive enemy retaliation | Adds 2 maximum health per level after level 1. |
| Bounty Hunting | Defeat enemies | Unlocks enemies and grants kill XP. |

Combat power also includes equipped item bonuses. Maximum health is:

```text
100 + 2 × (vitality level - 1) + equipment vitality
```

## Professions

A profession selects automatic work. It does not block other skills.

| Profession | Primary skill | Default `work` behavior |
|---|---|---|
| Lumberjack | Woodcutting | Gather a valid wood source. |
| Miner | Mining | Gather a valid ore source. |
| Hacker | Hacking | Gather from a valid terminal. |
| Smith | Smithing | Craft `smelt_metal_bar` when valid. |
| Artisan | Crafting | Craft `saw_planks` when valid. |
| Farmer | Farming | Gather from a valid established crop bed. |
| Cook | Cooking | Craft `cook_fish` when valid. |
| Engineer | Engineering | Build or repair a valid site. |

Use a direct named action to train outside the profession.

For example, a Miner that uses `work` selects Mining work. The same Miner can
use an available Cooking recipe with `craft` and gains Cooking XP. The agent
remains a Miner, and its profession rank continues to use Mining.

Crop-bed depletion and regeneration are the farming growth loop. There is no
`grow_mushrooms` recipe and no farmer default recipe. A farmer with `work`
selects a reachable crop source.

Each production recipe has one product item ID. Its output quantity can be more
than one. Recipe unlock levels do not come before direct dependency levels or
the output's use level.

## Read capability rows

| Goal | Required live condition | Action |
|---|---|---|
| Gather | Source `failureReason` is null; choose an `availableNodeId`. | `gather <nodeId>` |
| Craft | Recipe `failureReason` is null and `craftableBatches > 0`. | `craft <recipeId> <batches>` |
| Equip | Item ID is in `equippableItemIds`. | `equip <itemId>` |
| Heal | Item ID is in `healthItemIds`. | `use-item <itemId>` |
| Fight | The selected style failure reason is null. | `attack <enemyId> <style>` |
| Contract | Contract `failureReason` is null. | `deliver-contract <contractId>` |
| Build or repair | Site action matches and `failureReason` is null. | `build` or `repair` |

`failureReason` explains the largest current block, such as a low level,
missing inputs, the wrong area, depletion, or full integrity. Re-read
`progression` after every completed action because capabilities can change.

Construction sites require three parts whose names match the project. They also
install the machines listed in their requirements. Contract documents are
delivery evidence. They do not grant access by their item label.
