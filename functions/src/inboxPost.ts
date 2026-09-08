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

// apex.net.inbox.post の前半部分: validators.jsonld 〜 validators.activityObject
// (validators.inboxActivity は含まない。ADR-0038 で resolveLikeAnnounceObjectAsPlainObject を
// その直前に挿す必要があるため)
export const inboxValidationMiddlewares = originalInboxPost.slice(0, inboxActivityIndex);

// validators.inboxActivity 単体
export const inboxActivityValidator = apex.net.validators.inboxActivity;

// apex.net.inbox.post の後半部分: activity.resolveThread 〜 responders.status
export const inboxExecutionMiddlewares = originalInboxPost.slice(saveIndex + 1);
