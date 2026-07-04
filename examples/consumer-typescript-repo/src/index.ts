/**
 * A minimal consumer library. Run `semctx init --preset github-claude` at the repo root, then
 * `semctx index` and `semctx verify diff` to see change-impact analysis on your own diffs.
 *
 * @capability greeting
 * @invariant greeting-non-empty: a greeting must never be an empty string
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export interface GreeterPort {
  greet(name: string): string;
}
