// Domain: Ordered inline CSS. Owns: declaration data, property-operation order and serialization. Excludes: admission safety, engines and HTML escaping.

export type CssDeclaration = readonly [property: string, value: string];
export type CssDeclarationOperation = readonly [property: string, value: string | null];

const propertyKey = (property: string): string => property.startsWith('--') ? property : property.toLowerCase();

/** Apply caller-validated operations without mutating the source. Sets retain the first matching slot; removals delete all matches. */
export function applyDeclarationOperations(source: readonly CssDeclaration[], operations: readonly CssDeclarationOperation[]): CssDeclaration[] {
  const slots: Array<CssDeclaration | null> = [];
  const positions = new Map<string, number[]>();
  for (const [property, value] of source) {
    const key = propertyKey(property);
    const index = slots.length;
    slots.push([property, value]);
    const matches = positions.get(key);
    if (matches) matches.push(index);
    else positions.set(key, [index]);
  }
  // Tombstones keep other positions stable and avoid rescanning the whole block for every operation.
  for (const [property, value] of operations) {
    const key = propertyKey(property);
    const matches = positions.get(key);
    const first = matches?.[0];
    if (matches) for (const index of matches) slots[index] = null;
    if (value === null) {
      positions.delete(key);
      continue;
    }
    const index = first ?? slots.length;
    slots[index] = [property, value];
    positions.set(key, [index]);
  }
  return slots.filter((declaration): declaration is CssDeclaration => declaration !== null);
}

/** Serialize validated declarations as CSS, not HTML; preserve values, duplicates and order. */
export function serializeDeclarations(declarations: readonly CssDeclaration[], readable = false): string {
  const colon = readable ? ': ' : ':';
  return declarations.map(([property, value]) => `${property}${colon}${value}`).join(readable ? '; ' : ';');
}
