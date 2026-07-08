// Centralizes Ordering's access-control decisions.
//
// The authorization-service pattern: one injectable that answers "may this
// caller do this?", reused by controllers (and, for state changes, by the
// manager's `validationFn`).

import { type User } from '@causa/runtime';
import { Injectable } from '@nestjs/common';
import { ForbiddenError } from '../errors.js';
import { Order } from '../model/generated.js';
import { OrderNotFoundError } from './errors.js';

/**
 * Access-control decisions for orders.
 */
@Injectable()
export class OrderAuthorizationService {
  /**
   * Authorizes reading a single order: the order's own customer, or any staff
   * member.
   *
   * A non-owner, non-staff caller is answered with `404` (not `403`), so the
   * API never leaks the existence of orders belonging to other customers.
   *
   * @param actor The authenticated caller.
   * @param order The order being read (only `customer` is needed).
   */
  validateCanRead(actor: User, order: Pick<Order, 'customer'>): void {
    if (this.isStaff(actor) || actor.id === order.customer) {
      return;
    }

    throw new OrderNotFoundError();
  }

  /**
   * Authorizes listing a customer's orders: the customer themselves, or any
   * staff member.
   *
   * Unlike {@link OrderAuthorizationService.validateCanRead}, this answers a
   * disallowed request with `403`, not `404`: the caller named a customer
   * explicitly, so there is nothing to hide by pretending the listing is empty.
   *
   * @param actor The authenticated caller.
   * @param customer The customer whose orders are being listed.
   */
  validateCanList(actor: User, customer: string): void {
    if (customer === actor.id || this.isStaff(actor)) {
      return;
    }

    throw new ForbiddenError();
  }

  /**
   * Whether the caller carries the `staff` role. Roles arrive as a token claim,
   * and `User` is `{ id, [claim]: any }`, so the array shape is checked
   * defensively before looking for the role.
   *
   * This would usually be factored into a private common npm package, to be
   * reused by all services.
   */
  private isStaff(actor: User): boolean {
    return Array.isArray(actor.roles) && actor.roles.includes('staff');
  }
}
