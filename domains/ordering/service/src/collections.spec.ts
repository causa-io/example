// Security-rule tests for the client-facing Firestore collections.
//
// These do NOT boot the app. They exercise the deployed `firestore.rules`
// directly: a client, authenticated as various principals, reads/writes the
// `orders` collection through the Firestore emulator, and we assert which
// operations the rules allow or deny.
//
// The ruleset under test is the merged `.causa/firestore.rules` that Causa's
// `GoogleFirestoreMergeRules` processor produces from every domain's
// `firestore/*.rules` fragment and that Terraform deploys — so this asserts
// exactly what ships, helper functions and all. Requires the Firestore emulator
// (`FIRESTORE_EMULATOR_HOST`, from `.env`).

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import 'firebase/compat/app';
import { randomUUID } from 'node:crypto';

// The compat Firestore type each authenticated context exposes.
type Firestore = firebase.default.firestore.Firestore;

describe('collections', () => {
  let env: RulesTestEnvironment;

  // The customer who placed the orders — their auth uid equals the `customer`
  // field the rules gate on.
  const customerId = randomUUID();

  beforeAll(async () => {
    // The emulator already serves the merged `.causa/firestore.rules` (Causa
    // loads it), and project id + host come from `.env` — so no config is
    // needed.
    env = await initializeTestEnvironment({});
  });

  afterAll(() => env.cleanup());

  /**
   * A client authenticated as `uid`, carrying the given custom claims.
   */
  const asUser = (uid: string, claims?: Record<string, unknown>): Firestore =>
    env.authenticatedContext(uid, claims).firestore();

  describe('orders', () => {
    // Rules are evaluated against the QUERY, not against stored documents: a
    // read is allowed only if the rules can prove every matching document is
    // readable. So no document has to be seeded — the query's own constraints
    // are what the rules gate on.

    it('should let a customer read their own orders', async () => {
      await assertSucceeds(
        asUser(customerId)
          .collection('orders')
          .where('customer', '==', customerId)
          .get(),
      );
    });

    it('should let staff read any order', async () => {
      // `isStaff()` (a `roles` claim) allows reading every document, so an
      // unfiltered collection read is permitted.
      await assertSucceeds(
        asUser(randomUUID(), { roles: ['staff'] })
          .collection('orders')
          .get(),
      );
    });

    it('should forbid reading orders owned by another customer', async () => {
      await assertFails(
        asUser(customerId)
          .collection('orders')
          .where('customer', '==', randomUUID())
          .get(),
      );
    });

    it('should forbid an unauthenticated caller', async () => {
      await assertFails(
        env
          .unauthenticatedContext()
          .firestore()
          .collection('orders')
          .where('customer', '==', customerId)
          .get(),
      );
    });

    it('should forbid client writes', async () => {
      // `allow write: if false` — every write goes through the backend.
      await assertFails(
        asUser(customerId)
          .collection('orders')
          .doc(randomUUID())
          .set({ status: 'cancelled' }),
      );
    });
  });
});
