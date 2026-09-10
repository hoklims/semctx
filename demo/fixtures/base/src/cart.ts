export interface CartTotal {
  subtotalCents: number;
  taxCents: number;
}

export function computeCartTotal(subtotalCents: number, taxCents: number): CartTotal {
  return { subtotalCents, taxCents };
}
