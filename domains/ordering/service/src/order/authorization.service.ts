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
   * Authorizes listing every order that contains a given book: staff only.
   *
   * @param actor The authenticated caller.
   */
  validateCanListByBook(actor: User): void {
    if (this.isStaff(actor)) {
      return;
    }

    throw new ForbiddenError();
  }

  /**
   * Authorizes starting to process an order.
   *
   * Two layers, applied in order — *access* before *action*:
   * 1. The caller must be able to see the order at all
   *    ({@link OrderAuthorizationService.validateCanRead}: its customer or
   *    staff), else `404` — the API never reveals that someone else's order
   *    exists.
   * 2. Only then is the action gated: processing is staff-only, so an owner who
   *    *can* see their order but is not staff is refused with `403`.
   *
   * @param actor The authenticated caller.
   * @param order The stored order being processed (only `customer` is needed).
   */
  validateCanProcess(actor: User, order: Pick<Order, 'customer'>): void {
    this.validateCanRead(actor, order);

    if (this.isStaff(actor)) {
      return;
    }

    throw new ForbiddenError();
  }

  /**
   * Authorizes cancelling an order.
   *
   * Cancelling needs no permission beyond being able to *see* the order — its
   * own customer, or staff — so the access check is the whole decision, and
   * this is exactly {@link OrderAuthorizationService.validateCanRead}.
   * A caller who cannot see the order is therefore answered with `404`, never
   * `403`: this endpoint has no separate action gate to fail with a `403`.
   *
   * @param actor The authenticated caller.
   * @param order The stored order being cancelled (only `customer` is needed).
   */
  validateCanCancel(actor: User, order: Pick<Order, 'customer'>): void {
    this.validateCanRead(actor, order);
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
