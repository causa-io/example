# Pagination

Token (keyset) pagination for a list endpoint: a `QueryService` reads one ordered page from the database, seeded by a cursor, and the API returns the page plus a `nextPageQuery` the client follows to get the next one.

## The reason

A list endpoint must not return an unbounded result set, and "give me the next slice" has to stay correct while rows are being written. Two families of pagination solve this differently:

- **Offset pagination** (`LIMIT n OFFSET k`) is simple but wrong at scale: the database still scans and discards the `k` skipped rows (linear cost that grows with depth), and an insert or delete between two requests shifts every subsequent row, so pages silently duplicate or skip items.
- **Keyset (token / cursor) pagination** reads the page as an *ordered range scan* that starts immediately **after** the last row of the previous page. The cursor is the sort key of that row. Cost is constant per page (an index seek, not a scan-and-skip), and the boundary is stable under concurrent writes: a row inserted earlier in the list never shifts a later page. (See "gotchas" for even stronger guarantees.)

Causa's runtime ships keyset pagination as first-class primitives, so this is the default to reach for.

## The solution

Four pieces, three of them from `@causa/runtime/nestjs`.

### The page query and its opaque cursor (input)

`PageQuery<T>` is the base list query: it carries `limit` and `readAfter`, plus `withLimit({ default, max })` to default and **cap** the page size (one request must never ask Spanner for unbounded work).

The cursor is more than a single id here: orders are listed most recent first, and `createdAt` is not unique, so the sort — and therefore the cursor — is the **pair** `(createdAt, id)`. `id` (the primary key) breaks ties, which is what guarantees a page boundary never splits two rows ambiguously.

That composite cursor is modelled in two layers: an **HTTP query DTO** that owns the opaque-token encoding, and a plain **domain page query** the read service takes, free of any HTTP concern.

```typescript
// list-query.dto.ts — HTTP side: opaque cursor + parsing
export class OrderListReadAfterDto implements OrderListReadAfter {
  @IsDateType() readonly createdAt!: Date;
  @IsUUID() readonly id!: string;
}

export class OrderListQueryDto extends PageQuery<OrderListReadAfterDto> {
  @CustomReadAfterType()
  readonly readAfter?: OrderListReadAfterDto = undefined;

  static fromParams(params: OrderListQueryParams): Promise<OrderListQueryDto> {
    return parseObject(OrderListQueryDto, {
      limit: params.limit,
      readAfter: params.readAfter,
    });
  }
}

// types.ts — domain side: the query the OrderQueryService reads against
export type OrderListReadAfter = { readonly createdAt: Date; readonly id: string };

export class OrderPageQuery extends PageQuery<OrderListReadAfter> {
  withLimits() { return this.withLimit({ default: 20, max: 100 }); }
}
```

`@CustomReadAfterType()` makes the cursor **opaque and safe**. On the way out it is `base64(JSON(cursor))`, so clients treat it as a blob and never depend on its shape. On the way in it is decoded and the fields are validated (`@IsDateType`, `@IsUUID`). A malformed token fails fast with `400 invalidInput`, and a forged one can't smuggle arbitrary values past validation into the SQL.

Keeping that decoding decorator on the DTO means the query service only ever sees the plain `OrderPageQuery` — no dependency on the HTTP request layer. The controller decodes with the DTO, then builds an `OrderPageQuery` for the service. Every filter the listing accepts is a field on the query DTO too — here `customer`.

### The page (output)

`Page<T>` is the response wrapper — `{ items, nextPageQuery }`. Its constructor takes the items, the (limit-capped) query, and a resolver mapping the last item to a cursor. It derives `nextPageQuery` **only when the page came back full** (`items.length == limit`). A short page is the last one and yields `nextPageQuery: null`.

`nextPageQuery` serializes to a ready-to-use query string (`?limit=20&readAfter=…`). The client just appends it to the list path. It is the runtime `Page` shape, so the list DTO mirrors it:

```yaml
properties:
  items: { type: array, items: { $ref: ./order.dto.yaml } }
  nextPageQuery:
    oneOf: [{ type: string }, { type: "null" }]
```

### The keyset database query

The read lives in a dedicated `OrderQueryService` (single-entity reads by primary key stay on the command service). It issues one `entityManager.query`:

```sql
SELECT <columns>
FROM `Order`@{FORCE_INDEX=OrdersByCustomer}
WHERE customer = @customer
  AND deletedAt IS NULL
  AND ( createdAt < @readAfterCreatedAt
        OR (createdAt = @readAfterCreatedAt AND id > @readAfterId) )
ORDER BY createdAt DESC, id ASC
LIMIT @limit
```

The scan runs newest-first, breaking `createdAt` ties by ascending `id`. Note the directions are mixed (`createdAt` descending, `id` ascending), so the predicate is too (`<` then `>`). Every column's comparison must follow its own sort direction. Two details make it work:

- **First page seeding.** With no `readAfter`, the cursor is seeded to sort before every row — a year-9999 `createdAt` (the scan is most-recent-first). The `id` seed is then irrelevant, as no row shares that future timestamp.
- **Index alignment.** A secondary index whose key is exactly `(customer, createdAt DESC, id)` lets Spanner serve both the `WHERE` and the `ORDER BY` as a single range scan with **no sort step**. `id` is the primary key, which Spanner appends to every secondary index ascending — it is spelled out only to make the mixed-direction sort key visible. `sqlTable(Order, { index })` emits the `FORCE_INDEX` hint. Soft-deleted rows are filtered in the `WHERE`.

### Wiring it together (controller)

The controller stays thin: authorize, parse, query, map, serialize.

```typescript
@TryMap(forbiddenErrorAsDto)
async list(query: OrderListQueryParams, @AuthUser() actor: User) {
  const customer = query.customer ?? actor.id;
  this.authorizationService.validateCanList(actor, customer);
  const validatedQuery = (await OrderListQueryDto.fromParams(query)).withLimit(ORDER_LIST_LIMITS);
  const page = await this.queryService.listByCustomer(
    customer,
    new OrderPageQuery({ limit: validatedQuery.limit, readAfter: validatedQuery.readAfter }),
  );
  return page.map(toOrderPublicDto, validatedQuery).serialize();
}
```

The controller owns the default — no `customer` filter means the caller's own orders. `validateCanList` then just *gates*: the target customer must be the caller, or the caller must be staff. Unlike a single-order read, which hides other customers behind a `404`, listing names the customer explicitly, so "forbidden" is the honest answer.

## Gotchas

- **`Page.map(fn, query)` must be given the query, and it must be the DTO.** The two-argument form re-types the cursor via the query's `@CustomReadAfterType` metadata before the page is rebuilt, so the query passed must be the decorator-bearing `OrderListQueryDto` (not the plain `OrderPageQuery`).
- **`nextPageQuery` is null only on a *short* page.** A page that happens to be exactly `limit` long still returns a cursor. The client learns it has reached the end when the *next* request comes back empty. Don't treat "full page" as "more pages guaranteed".
- **Cap the limit server-side.** `withLimit({ default, max })` both fills in a default and clamps the client's `limit`. The `WithLimit<…>` return type makes "a bound was applied" a compile-time guarantee before the query runs.
- **The cursor is validated, so its fields must be valid.** Because `readAfter` decodes into a validated DTO, ids in the data must be real UUIDs — a row keyed by a non-UUID string would list fine but fail when its cursor round-trips.
- **Every filter must live on the query DTO.** `nextPageQuery` is built by serializing the whole query, so a filter only read off the raw params (not declared on `OrderListQueryDto`) is absent from page two and the listing silently re-scopes.
- **Stable pages are not a consistent snapshot.** Keyset paging survives concurrent inserts and deletes without skipping or duplicating rows (see *The reason*), but successive pages are still *separate* reads: a row changed between page one and page three shows its newer state, and the total set can shift under you. When a listing must reflect a single point in time across every page, put a **read timestamp** in the cursor and pass it as a Spanner read-only transaction option, so each page reads from that same snapshot. It trades freshness (later pages ignore newer writes) for consistency — most listings don't need it, which is why it isn't here.
- **Validation is not authorization.** `@CustomReadAfterType` checks the cursor's *shape* (a real date, a real UUID), not its *provenance*: the token is base64, not signed, so a client can decode it, change a still-valid value, and re-send. So the cursor must not carry authorization-sensitive data — or, if it must, that data has to be re-validated on every request. Here it carries neither: `readAfter` holds only the `(createdAt, id)` sort keys, and the `customer` scope is re-authorized by `validateCanList` on *every* page, cursor or not.

## In this repository

- The HTTP query DTO and opaque composite cursor — [list-query.dto.ts](../domains/ordering/service/src/order/list-query.dto.ts); the plain domain page query it feeds — [types.ts](../domains/ordering/service/src/order/types.ts) (`OrderPageQuery`).
- The keyset read (SQL, `FORCE_INDEX`, first-page sentinel, `Page`) — [query.service.ts](../domains/ordering/service/src/order/query.service.ts).
- The controller (authorize → parse → query → `map`/`serialize`) — [api.controller.ts](../domains/ordering/service/src/order/api.controller.ts) (`list`).
- Gating the listing (`403` for a non-staff cross-customer request) — [authorization.service.ts](../domains/ordering/service/src/order/authorization.service.ts) (`validateCanList`), throwing the service-wide [ForbiddenError](../domains/ordering/service/src/errors.ts) mapped to the `forbidden` DTO in [dto.utils.ts](../domains/ordering/service/src/order/dto.utils.ts).
- The API contract (query params `customer` / `limit` / `readAfter`, `200` page, `403`) — [order.api.yaml](../domains/ordering/api/order.api.yaml) and the response DTO [order-list.dto.yaml](../domains/ordering/api/dtos/order-list.dto.yaml) (the catalogue's [book-list.dto.yaml](../domains/catalog/api/dtos/book-list.dto.yaml) mirrors the shape).
- The backing index `(customer, createdAt DESC, id)` — [0004-add-orders-by-customer-index.sql](../domains/ordering/spanner/0004-add-orders-by-customer-index.sql).
- The behavior under test (ordering, page-by-cursor, the `id` tie-break across a boundary, empty-page termination, other-customer / soft-deleted exclusion, staff vs `403`, malformed cursor → `400`) — [api.controller.list.spec.ts](../domains/ordering/service/src/order/api.controller.list.spec.ts).
