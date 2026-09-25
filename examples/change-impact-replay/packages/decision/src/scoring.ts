/** Scoring weights for candidate actions. Unrelated to protocol pins. */
export function scoreAction(damage: number, risk: number): number {
  return damage * 2 - risk;
}
