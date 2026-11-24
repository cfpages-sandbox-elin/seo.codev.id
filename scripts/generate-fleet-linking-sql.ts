/**
 * RETIRED: This standalone SQL generator is retired in favor of the canonical,
 * schema-safe, atomic, and dry-run capable `scripts/link-github-fleet.ts`.
 *
 * To preview fleet linking actions safely without database mutations:
 *   pnpm exec tsx scripts/link-github-fleet.ts --dry-run
 *
 * To apply fleet linking to remote D1:
 *   pnpm exec tsx scripts/link-github-fleet.ts
 */

console.warn(
  "[DEPRECATED] `generate-fleet-linking-sql.ts` is retired. Use `scripts/link-github-fleet.ts --dry-run` to preview the canonical linking plan.",
);
process.exit(1);
