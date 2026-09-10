export interface CartTotal {
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
}

export function computeCartTotal(subtotalCents: number, taxCents: number, discountCents: number): CartTotal {
  return { subtotalCents, taxCents, discountCents };
}
