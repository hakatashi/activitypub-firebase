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

		// Denormalize objectTypes
		const objects = stream.object ?? [];
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
	});
});

