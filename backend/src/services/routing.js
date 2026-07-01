/* ============================================================
   CHHAPERIA ERP — BACKEND · routing service
   Maps finished goods to their production line.
   Used when creating work orders to set the correct line.
   ============================================================ */
"use strict";

/**
 * Returns the production line for a given finished good item.
 * Based on product group and optional deterministic distribution.
 * 
 * @param {Object} item - The item definition from items array (must have .group and .id)
 * @returns {string} One of: "Coating Line 1", "Coating Line 2", "Slitting A", "Slitting B", "Fiberglass Line"
 */
function getLineForItem(item) {
  // Map group to possible lines
  const group = (item.group || "").toUpperCase();
  const id = item.id || "";
  
  // Simple hash to distribute items evenly across lines for the same group
  const hash = Array.from(id).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  
  if (group === "MICA" || group === "WBT") {
    // Distribute between two coating lines
    return (hash % 2 === 0) ? "Coating Line 1" : "Coating Line 2";
  }
  if (group === "SCT") {
    // Maybe also coating? We'll put them on coating lines as well
    return (hash % 2 === 0) ? "Coating Line 1" : "Coating Line 2";
  }
  if (group === "OCT") {
    // For OCT, we need to decide: some might be coating, some fiberglass, some slitting?
    // For simplicity, assign all OCT to Fiberglass Line to give fiberglass supervisor work.
    // Alternatively, we could check if the item is specifically fiberglass tape.
    if (id.includes("FG-FG") || id.includes("FIBERGLASS") || id.includes("FG-T")) {
      return "Fiberglass Line";
    }
    // Default OCT to coating? Let's put them on coating lines as well.
    return (hash % 2 === 0) ? "Coating Line 1" : "Coating Line 2";
  }
  // Fallback
  return "Coating Line 1";
}

module.exports = { getLineForItem };