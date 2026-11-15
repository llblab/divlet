// Domain: Source-work budgets. Owns: the shared bounded source/import/resource capacities, not model admission or host I/O.
export const SOURCE_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, nodes: 10000, depth: 64, roots: 200 });
