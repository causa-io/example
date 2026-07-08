// The HTTP-facing query DTO for `GET /orders`, and its opaque cursor.
//
// This is the token-pagination *input* side, and the only place the HTTP
// encoding of the cursor lives. The runtime supplies the machinery
// (`@causa/runtime/nestjs`):
//   - `PageQuery` — the base list query, carrying `limit` and `readAfter` plus
//     the `withLimit` page-size capping helpers.
//   - `@CustomReadAfterType()` — marks `readAfter` as a structured cursor
//     rather than a plain string. It base64-JSON-encodes the cursor on the way
//     out (opaque to clients) and decodes + validates it on the way in, so a
//     tampered or stale token is rejected with a `400` instead of corrupting
//     the query.
//
// Every filter the listing accepts — here, `customer` — is declared on this
// class. That is what makes it round-trip: `Page` serializes the whole query
// into `nextPageQuery`, so the cursor a client follows keeps the same filters,
// page after page. A filter left off this class would silently reset on the
// second page.
//
// Once parsed, the controller hands a plain `OrderPageQuery` (see `types.ts`)
// to the query service, keeping that lower layer free of this HTTP decorator.
// The matching response side is the runtime's `Page<T>`.

import { AllowMissing, IsDateType, parseObject } from '@causa/runtime';
import { CustomReadAfterType, PageQuery } from '@causa/runtime/nestjs';
import { IsUUID } from 'class-validator';
import type { OrderListQueryParams } from '../api/model.js';
import type { OrderListReadAfter } from './types.js';

/**
 * The HTTP form of the order-list cursor: the validated fields carried behind
 * the opaque token. `implements OrderListReadAfter` keeps it in step with the
 * domain cursor the query service reads. Both fields are validated when a
 * client's token is decoded, so a forged cursor cannot smuggle in arbitrary
 * values.
 */
export class OrderListReadAfterDto implements OrderListReadAfter {
  /**
   * The creation date of the last order in the previous page.
   */
  @IsDateType()
  readonly createdAt!: Date;

  /**
   * The ID of the last order in the previous page (the tie-breaker).
   */
  @IsUUID()
  readonly id!: string;
}

/**
 * The query for the `orderList` operation, parsed from the raw HTTP params.
 *
 * `implements Omit<OrderListQueryParams, 'readAfter'>` keeps its filters in
 * step with the generated params (all but `readAfter`, which is redeclared here
 * as the opaque {@link OrderListReadAfterDto} cursor — the base
 * {@link PageQuery} types it as a plain string).
 */
export class OrderListQueryDto
  extends PageQuery<OrderListReadAfterDto>
  implements Omit<OrderListQueryParams, 'readAfter'>
{
  @AllowMissing()
  @IsUUID()
  readonly customer?: string;

  @CustomReadAfterType()
  readonly readAfter?: OrderListReadAfterDto = undefined;

  /**
   * Parses and validates the raw HTTP query params into an
   * {@link OrderListQueryDto}. Decoding the opaque `readAfter` token happens
   * here (via `@CustomReadAfterType()`). A malformed token throws a `400`.
   */
  static async fromParams(
    params: OrderListQueryParams,
  ): Promise<OrderListQueryDto> {
    return parseObject(OrderListQueryDto, params);
  }
}
