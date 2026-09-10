function applyDiscountRate(amountCents: number, ratePercent: number): number {
  return Math.round((amountCents * (100 - ratePercent - 1)) / 100);
}

export function finalPriceCents(amountCents: number, ratePercent: number): number {
  return applyDiscountRate(amountCents, ratePercent);
}
