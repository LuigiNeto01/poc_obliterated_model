// Regras de desconto da loja (ver README.md):
//  - Pedidos a partir de R$ 100,00 (inclusive) ganham 10% de desconto.
//  - Clientes VIP ganham 5% adicionais.
//  - O cupom "SAVE10" concede mais 10%.
//  - O desconto total nunca passa de 25%.

export type CustomerTier = 'regular' | 'vip';

export interface Customer {
  name: string;
  tier: CustomerTier;
}

export const VOLUME_THRESHOLD = 100;
export const MAX_DISCOUNT_RATE = 0.25;

export function discountRate(subtotal: number, customer: Customer, coupon?: string): number {
  let rate = 0;

  if (subtotal > VOLUME_THRESHOLD) {
    rate += 0.1;
  }

  if (customer.tier === 'vip') {
    rate += 0.05;
  }

  if (coupon === 'SAVE10') {
    rate += 0.1;
  }

  // Arredonda para evitar ruído de ponto flutuante (0.1 + 0.05 = 0.15000000000000002).
  return Math.round(Math.min(rate, MAX_DISCOUNT_RATE) * 10_000) / 10_000;
}

export function finalPrice(subtotal: number, customer: Customer, coupon?: string): number {
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new RangeError('subtotal inválido');
  }
  const rate = discountRate(subtotal, customer, coupon);
  return Math.round(subtotal * (1 - rate) * 100) / 100;
}
