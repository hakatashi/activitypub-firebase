import {db} from '../src/firebase';

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
});

