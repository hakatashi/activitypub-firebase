/* global describe, beforeAll, beforeEach, it, expect */

describe('default store', function () {
  let testUser
  let apex
  let client
  beforeAll(async function () {
    const init = await global.initApex()
    testUser = init.testUser
    apex = init.apex
    client = init.client
  })
  beforeEach(function () {
    return global.resetDb(apex, client, testUser)
  })
  describe('denormalized updates', function () {
    // SKIP REASON (Issue #115 / ADR-0021 / ADR-0052):
    // Firestore Store's updateObjectCopies relies on the _meta.index denormalization written by
    // Cloud Functions trigger (onStreamWritten in denormalizations.ts). In unit test environment,
    // the trigger does not run, so nested copies in streams are not updated without pre-built index.
    it.skip('updates nested objects', async function () {
      const create = await apex.buildActivity('Create', testUser.id, [testUser.id], {
        object: [{
          id: 'https://localhost/o/abc123',
          attributedTo: testUser.id,
          type: 'Note',
          content: 'Hello'
        }, {
          id: 'https://localhost/o/notupdated',
          attributedTo: testUser.id,
          type: 'Note',
          content: 'Goodbye'
        }]
      })
      await apex.store.saveActivity(create)
      await apex.store.saveObject(create.object[0])
      const updated = {
        id: 'https://localhost/o/abc123',
        type: 'Note',
        attributedTo: [testUser.id],
        content: ['Hello again']
      }
      const notUpdated = {
        id: 'https://localhost/o/notupdated',
        type: 'Note',
        attributedTo: [testUser.id],
        content: ['Goodbye']
      }
      await apex.store.updateObject(updated, testUser.id, true)
      const newCreate = await apex.store.getActivity(create.id)
      expect(newCreate.object).toEqual([updated, notUpdated])
    })
    // SKIP REASON (Issue #115 / ADR-0003 / ADR-0052):
    // Delivery is handled via Cloud Tasks. Store.deliveryDequeue is an intentional stub,
    // and worker tasks re-read the actor's latest key on delivery rather than storing
    // and mutating keys in a local delivery queue.
    it.skip('updates queued signing keys', async function () {
      await apex.store
        .deliveryEnqueue(testUser.id, 'hello', testUser.inbox, testUser._meta.privateKey)
      testUser._meta.privateKey = 'newkey'
      await apex.store.updateObject(testUser, testUser.id, true)
      const updated = await apex.store.deliveryDequeue()
      delete updated.after
      expect(updated).toEqual({
        actorId: testUser.id,
        body: 'hello',
        address: testUser.inbox[0],
        attempt: 0,
        signingKey: 'newkey'
      })
    })
  })
  describe('getStream', function () {
    // SKIP REASON (Issue #115 / ADR-0052):
    // The optional query argument here uses MongoDB aggregation pipeline ($match),
    // which is specific to MongoDB Store and not supported by Firestore Store.
    it.skip('applies optional query argument to aggregation pipeline', async function () {
      const create = await apex.buildActivity('Create', testUser.id, [testUser.id], {
        object: [{
          id: 'https://localhost/o/abc123',
          attributedTo: testUser.id,
          type: 'Note',
          content: 'Hello'
        }]
      })
      apex.addMeta(create, 'collection', testUser.outbox[0])
      await apex.store.saveActivity(create)
      const arrive = await apex.buildActivity('Arrive', testUser.id, [testUser.id], {
        target: [{
          id: 'https://localhost/o/immer',
          type: 'Place',
          url: 'https://localhost'
        }]
      })
      apex.addMeta(arrive, 'collection', testUser.outbox[0])
      await apex.store.saveActivity(arrive)
      const filtered = await apex.store.getStream(testUser.outbox[0], 10, null, null, [{ $match: { type: 'Arrive' } }])
      expect(filtered.length).toBe(1)
      expect(filtered[0].type).toBe('Arrive')
      const unfiltered = await apex.store.getStream(testUser.outbox[0], 10)
      expect(unfiltered.length).toBe(2)
    })
  })
})
