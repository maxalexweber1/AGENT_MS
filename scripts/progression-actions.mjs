export const progressionCommandHelp = [
  "gather <nodeId>",
  "craft <recipeId> <batches>",
  "equip <itemId>",
  "unequip <slot>",
  "use-item <itemId>",
  "attack <enemyId> <melee|ranged>",
  "deliver-contract <contractId>",
  "build <siteId>",
  "repair <siteId>",
];

export function buildProgressionAction(command, args) {
  switch (command) {
    case "gather":
      exactArgs(args, 1, "gather <nodeId>");
      return { kind: "gather", nodeId: text(args[0], "nodeId") };
    case "craft":
      exactArgs(args, 2, "craft <recipeId> <batches>");
      return {
        kind: "craft",
        recipeId: text(args[0], "recipeId"),
        batches: positiveInteger(args[1], "batches", 100),
      };
    case "equip":
      exactArgs(args, 1, "equip <itemId>");
      return { kind: "equip", itemId: text(args[0], "itemId") };
    case "unequip":
      exactArgs(args, 1, "unequip <slot>");
      return { kind: "unequip", slot: text(args[0], "slot") };
    case "use-item":
      exactArgs(args, 1, "use-item <itemId>");
      return { kind: "use_item", itemId: text(args[0], "itemId") };
    case "attack": {
      exactArgs(args, 2, "attack <enemyId> <melee|ranged>");
      const style = text(args[1], "style");
      if (style !== "melee" && style !== "ranged") {
        throw new Error("style must be melee or ranged");
      }
      return { kind: "attack", enemyId: text(args[0], "enemyId"), style };
    }
    case "deliver-contract":
      exactArgs(args, 1, "deliver-contract <contractId>");
      return { kind: "deliver_contract", contractId: text(args[0], "contractId") };
    case "build":
    case "repair":
      exactArgs(args, 1, `${command} <siteId>`);
      return { kind: command, siteId: text(args[0], "siteId") };
    default:
      return null;
  }
}

export function progressionOutcomeFields(payload, action) {
  switch (action.kind) {
    case "gather":
      return payload.kind === "resource_gathered" && payload.nodeId === action.nodeId
        ? pick(payload, ["nodeId", "itemId", "quantity", "total"])
        : null;
    case "craft":
      return payload.kind === "item_crafted" && payload.recipeId === action.recipeId
        ? pick(payload, ["recipeId", "batches", "outputs"])
        : null;
    case "equip":
      return payload.kind === "equipment_changed" && payload.itemId === action.itemId
        ? pick(payload, ["slot", "itemId"])
        : null;
    case "unequip":
      return payload.kind === "equipment_changed" && payload.slot === action.slot && payload.itemId == null
        ? pick(payload, ["slot", "itemId"])
        : null;
    case "use_item":
      return payload.kind === "agent_healed" && payload.itemId === action.itemId
        ? pick(payload, ["itemId", "healthBefore", "healthAfter"])
        : null;
    case "attack":
      if (payload.enemyId !== action.enemyId) return null;
      if (payload.kind === "enemy_defeated") {
        return { defeated: true, ...pick(payload, ["enemyId", "loot", "availableAtTick"]) };
      }
      return payload.kind === "enemy_damaged"
        ? { defeated: false, ...pick(payload, ["enemyId", "damage", "healthRemaining"]) }
        : null;
    case "deliver_contract":
      return payload.kind === "contract_completed" && payload.contractId === action.contractId
        ? pick(payload, ["contractId", "rewards"])
        : null;
    case "build":
    case "repair":
      return payload.kind === "construction_changed" && payload.siteId === action.siteId
        ? pick(payload, ["siteId", "integrity", "commissioned"])
        : null;
    default:
      return null;
  }
}

export function findContentDefinition(staticWorldResponse, kindValue, idValue) {
  const kind = text(kindValue, "kind");
  const id = text(idValue, "id");
  const collections = {
    item: "items",
    recipe: "recipes",
    source: "sources",
    enemy: "enemies",
    contract: "contracts",
    site: "constructionSites",
  };
  const collection = collections[kind];
  if (collection === undefined) {
    throw new Error(`kind must be one of: ${Object.keys(collections).join(", ")}`);
  }
  const gameContent = staticWorldResponse?.staticWorld?.gameContent;
  const definition = gameContent?.[collection]?.find((candidate) => candidate?.id === id);
  if (definition === undefined) throw new Error(`${kind} not found: ${id}`);
  return { contentVersion: gameContent.version ?? null, kind, definition };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}

function exactArgs(args, count, usage) {
  if (args.length !== count) throw new Error(`usage: ${usage}`);
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, name, maximum) {
  const raw = text(value, name);
  const parsed = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}
