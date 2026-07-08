// The controller-boundary mapping layer for the Ordering domain.
//
// Two kinds of mapping live here, both keeping the layers below HTTP-agnostic:
//   - internal service errors → public error DTOs, declared as `@TryMap` cases;
//   - the stored `Order` entity → the public `OrderPublicDto` returned by the API.

import {
  ForbiddenErrorDto,
  NotFoundErrorDto,
  toDto,
  toDtoType,
} from '@causa/runtime/nestjs';
import { BookNotFoundError, BookUnavailableError } from '../catalog/errors.js';
import { ForbiddenError } from '../errors.js';
import {
  BookNotFoundErrorDto,
  BookUnavailableErrorDto,
  Order,
  OrderPublicDto,
} from '../model/generated.js';
import { OrderNotFoundError } from './errors.js';

/**
 * Maps {@link OrderNotFoundError} to the shared `404 notFound` DTO.
 * `toDtoType` suffices: the DTO carries nothing beyond the status/code/message,
 * so the runtime just instantiates it.
 */
export const orderNotFoundErrorAsDto = toDtoType(
  OrderNotFoundError,
  NotFoundErrorDto,
);

/**
 * Maps the service-wide {@link ForbiddenError} to the shared `403 forbidden`
 * DTO.
 */
export const forbiddenErrorAsDto = toDtoType(ForbiddenError, ForbiddenErrorDto);

/**
 * Maps {@link BookNotFoundError} to the domain-specific `ordering.bookNotFound`
 * DTO. `toDto` (not `toDtoType`) is used because this DTO carries extra data —
 * the offending book IDs — copied from the error into the response body.
 */
export const bookNotFoundErrorAsDto = toDto(
  BookNotFoundError,
  ({ books }) =>
    new BookNotFoundErrorDto({
      statusCode: 400,
      errorCode: 'ordering.bookNotFound',
      message: 'One or more ordered books do not exist.',
      books,
    }),
);

/**
 * Maps {@link BookUnavailableError} to the `ordering.bookUnavailable` DTO,
 * likewise carrying the offending book IDs.
 */
export const bookUnavailableErrorAsDto = toDto(
  BookUnavailableError,
  ({ books }) =>
    new BookUnavailableErrorDto({
      statusCode: 400,
      errorCode: 'ordering.bookUnavailable',
      message: 'One or more ordered books cannot currently be ordered.',
      books,
    }),
);

/**
 * Projects a stored {@link Order} onto the public {@link OrderPublicDto}.
 */
export function toOrderPublicDto(order: Order): OrderPublicDto {
  return new OrderPublicDto({
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    customer: order.customer,
    status: order.status,
    lines: order.lines,
  });
}
