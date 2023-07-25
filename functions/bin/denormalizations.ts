import {countBy} from 'lodash-es';
import {db, unescapeFirestoreKey} from '../src/firebase';
import {UserInfos} from '../src/schema';

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
	const userInfos = await transaction.get(UserInfos);

	const statusCounts = countBy(
		streams.docs.filter((streamDoc) => (
			(streamDoc.data().objects ?? []).some((object) => object.type === 'Note')
		)),
		(streamDoc) => streamDoc.data().actor[0],
	);

	streams.docs.forEach((streamDoc) => {
		const stream = streamDoc.data();

		const objects = stream.object ?? [];

		// Denormalize objectTypes
		// eslint-disable-next-line private-props/no-use-outside, no-underscore-dangle
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
		// eslint-disable-next-line private-props/no-use-outside, no-underscore-dangle
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
	});
});

