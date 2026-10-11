import { describe, expect, test } from 'vitest';
import {
	activitypub,
	beforeUserCreate,
	cleanupMediaTask,
	deliveryTask,
	mastodonApi,
	mediaUploadApi,
	onStreamCreated,
	onStreamWritten,
	pingTask,
	remoteActorRefreshTask,
} from '../../src/index.js';

describe('Function regions (ADR-0119)', () => {
	const allFunctions = [
		{ name: 'activitypub', fn: activitypub },
		{ name: 'mastodonApi', fn: mastodonApi },
		{ name: 'mediaUploadApi', fn: mediaUploadApi },
		{ name: 'beforeUserCreate', fn: beforeUserCreate },
		{ name: 'onStreamWritten', fn: onStreamWritten },
		{ name: 'onStreamCreated', fn: onStreamCreated },
		{ name: 'pingTask', fn: pingTask },
		{ name: 'deliveryTask', fn: deliveryTask },
		{ name: 'remoteActorRefreshTask', fn: remoteActorRefreshTask },
		{ name: 'cleanupMediaTask', fn: cleanupMediaTask },
	];

	test.each(allFunctions)('$name is deployed to asia-northeast1', ({ fn }) => {
		const endpoint = (fn as unknown as Record<string, unknown>)['__endpoint'] as
			| { region?: string[] }
			| undefined;
		expect(endpoint?.region).toEqual(['asia-northeast1']);
	});
});
