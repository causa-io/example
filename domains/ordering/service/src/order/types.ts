// Local types for the Order feature.
//
// Command/query shapes that are not entities or DTOs live here, keeping the
// service and controller files focused on behavior.

import type { Order } from '../model/generated.js';

/**
 * The data required to place a new {@link Order}.
 */
export type PlaceOrderData = Pick<Order, 'customer' | 'lines'>;
