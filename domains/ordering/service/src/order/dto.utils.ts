// The controller-boundary mapping layer for the Ordering domain.
//
// Two kinds of mapping live here, both keeping the layers below HTTP-agnostic:
//   - internal service errors → public error DTOs, declared as `@TryMap` cases;
//   - the stored `Order` entity → the public `OrderPublicDto` returned by the API.

import { IncorrectEntityVersionError } from '@causa/runtime';
import {
  ForbiddenErrorDto,
  IncorrectVersionErrorDto,
  NotFoundErrorDto,
  toDto,
  toDtoType,
  ValidationErrorDto,
} from '@causa/runtime/nestjs';
import { BookNotFoundError, BookUnavailableError } from '../catalog/errors.js';
import { ForbiddenError } from '../errors.js';
import {
  BookNotFoundErrorDto,
  BookUnavailableErrorDto,
  InvalidOrderStatusErrorDto,
  Order,
  OrderPublicDto,
} from '../model/generated.js';
import {
  InvalidOrderStatusError,
  OrderNotFoundError,
  OrderValidationError,
} from './errors.js';

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
 * Maps {@link OrderValidationError} — the validator's accumulated value-check
 * failures — to the shared `400 invalidInput` {@link ValidationErrorDto}, the
 * very DTO the framework's `ValidationPipe` returns for shape errors. So a
 * client sees semantic and shape validation failures in one uniform shape.
 */
export const orderValidationErrorAsDto = toDto(
  OrderValidationError,
  ({ validationMessages, fields }) =>
    new ValidationErrorDto(
      validationMessages.map((message) => `- ${message}`).join('\n'),
      fields,
    ),
);

/**
 * Maps {@link InvalidOrderStatusError} to the domain `400
 * ordering.invalidOrderStatus` DTO.
 *
 * `toDto` (not `toDtoType`) is required even though there is no extra payload:
 * `InvalidOrderStatusErrorDto` is a plain generated class whose `statusCode` /
 * `errorCode` are only validated (`@Equals`) fields, not runtime defaults.
 * Instantiating it with no arguments (`toDtoType`) would leave `statusCode`
 * `undefined`, so the response would not get a `400`.
 * The shared runtime DTOs (see {@link incorrectVersionErrorAsDto}) hardcode
 * their own status, which is the only case `toDtoType` covers.
 */
export const invalidOrderStatusErrorAsDto = toDto(
  InvalidOrderStatusError,
  ({ status }) =>
    new InvalidOrderStatusErrorDto({
      statusCode: 400,
      errorCode: 'ordering.invalidOrderStatus',
      message: `The order cannot be changed from its '${status}' status.`,
    }),
);

/**
 * Maps the runtime's {@link IncorrectEntityVersionError} — thrown by
 * `VersionedEntityManager.update` when the client's `checkUpdatedAt` does not
 * match the stored `updatedAt` — to the shared `409 incorrectVersion` DTO.
 * See the optimistic-concurrency-control pattern.
 */
export const incorrectVersionErrorAsDto = toDtoType(
  IncorrectEntityVersionError,
  IncorrectVersionErrorDto,
);

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
