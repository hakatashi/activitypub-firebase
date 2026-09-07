import assert from 'node:assert';
import { apex } from './apex.js';

const originalInboxPost = apex.net.inbox.post;
const inboxActivityIndex = originalInboxPost.indexOf(apex.net.validators.inboxActivity);
const saveIndex = originalInboxPost.indexOf(apex.net.activity.save);
assert(
	inboxActivityIndex !== -1,
	'apex.net.validators.inboxActivity not found in inbox post middleware chain',
);
assert(saveIndex !== -1, 'apex.net.activity.save not found in inbox post middleware chain');
assert(
	inboxActivityIndex + 1 === saveIndex,
	'unexpected middleware between inboxActivity and save in apex.net.inbox.post',
);

// apex.net.inbox.post の前半部分: validators.jsonld 〜 validators.inboxActivity
export const inboxValidationMiddlewares = originalInboxPost.slice(0, inboxActivityIndex + 1);

// apex.net.inbox.post の後半部分: activity.resolveThread 〜 responders.status
export const inboxExecutionMiddlewares = originalInboxPost.slice(saveIndex + 1);
