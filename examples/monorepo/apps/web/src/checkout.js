import { addCents } from "@example/money";

export const orderTotal = (lineCents, shippingCents) => addCents(lineCents, shippingCents);
