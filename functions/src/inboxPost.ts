import assert from 'node:assert';
import { apex } from './apex.js';

const originalInboxPost = apex.net.inbox.post;
const saveIndex = originalInboxPost.indexOf(apex.net.activity.save);
assert(saveIndex !== -1, 'apex.net.activity.save not found in inbox post middleware chain');

// apex.net.inbox.post の前半部分: validators.jsonld 〜 validators.inboxActivity
export const inboxValidationMiddlewares = originalInboxPost.slice(0, saveIndex);

// apex.net.inbox.post の後半部分: activity.resolveThread 〜 responders.status
export const inboxExecutionMiddlewares = originalInboxPost.slice(saveIndex + 1);
