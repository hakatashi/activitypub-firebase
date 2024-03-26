import assert from 'assert';
import {countBy} from 'lodash-es';
import {db, unescapeFirestoreKey} from '../src/firebase.js';
import {UserInfos} from '../src/schema.js';

const setEqual = <T>(a: Set<T>, b: Set<T>) => {
	if (a.size !== b.size) {
		return false;
	}
	for (const item of a) {
		if (!b.has(item)) {
			return false;
		}
	}
	return true;
};

db.runTransaction(async (transaction) => {
	const streams = await transaction.get(db.collection('streams'));
	console.log(`streams: ${streams.docs.length}`);

	const userInfos = await transaction.get(UserInfos);
	console.log(`userInfos: ${userInfos.docs.length}`);

	const statusCounts = countBy(
		streams.docs.filter((streamDoc) => (
			(streamDoc.data().object ?? []).some((object: any) => object.type === 'Note')
		)),
		(streamDoc) => streamDoc.data().actor[0],
	);

	const follows = streams.docs
		.filter((streamDoc) => streamDoc.data().type === 'Follow')
		.flatMap((streamDoc) => streamDoc.data().object ?? []);
	const followCounts = countBy(follows, (object: any) => object);

	const unfollows = streams.docs
		.filter((streamDoc) => streamDoc.data().type === 'Undo')
		.flatMap((streamDoc) => streamDoc.data().object ?? [])
		.filter((object: any) => object.type === 'Follow')
		.flatMap((object: any) => object.object ?? []);
	const unfollowCounts = countBy(unfollows, (object: any) => object);

	streams.docs.forEach((streamDoc) => {
		const stream = streamDoc.data();

		const objects = stream.object ?? [];

		// Denormalize objectTypes
		const oldObjectTypes = new Set<string>(stream._meta?.objectTypes ?? []);
		const newObjectTypes = new Set<string>(
			objects
				.map((object: any) => object.type)
				.filter((objectType: any) => typeof objectType === 'string'),
		);

		if (!setEqual(oldObjectTypes, newObjectTypes)) {
			transaction.update(streamDoc.ref, {
				'_meta.objectTypes': Array.from(newObjectTypes),
			});
		}

		// Denormalize objectType
		const oldObjectType = stream._meta?.objectType ?? undefined;
		const newObjectType =
		objects
			.map((object: any) => object.type)
			.find((objectType: any) => typeof objectType === 'string');

		if (oldObjectType !== newObjectType) {
			transaction.update(streamDoc.ref, {
				'_meta.objectType': newObjectType,
			});
		}

		// Denormalize _meta.collection
		if (Array.isArray(stream._meta?.collection)) {
			assert(stream._meta.collection.length === 1);
			transaction.update(streamDoc.ref, {
				'_meta.collection': stream._meta.collection[0],
			});
		}
	});

	userInfos.docs.forEach((userInfoDoc) => {
		const userInfo = userInfoDoc.data();
		const actorId = unescapeFirestoreKey(userInfoDoc.id);

		// Denormalize statuses_count
		const oldStatusCount = userInfo.statuses_count;
		const newStatusCount = statusCounts[actorId] ?? 0;
		if (oldStatusCount !== newStatusCount) {
			transaction.update(userInfoDoc.ref, {
				statuses_count: newStatusCount,
			});
		}

		// Denormalize followers_count
		const oldFollowersCount = userInfo.followers_count;
		const newFollowersCount = (followCounts[actorId] ?? 0) - (unfollowCounts[actorId] ?? 0);
		if (oldFollowersCount !== newFollowersCount) {
			transaction.update(userInfoDoc.ref, {
				followers_count: newFollowersCount,
			});
		}
	});
});

