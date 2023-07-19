import {
	onDocumentWritten,
} from 'firebase-functions/v2/firestore';

// Check if given two sets are equal
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

export const onStreamWritten = onDocumentWritten('streams/{streamId}', async (event) => {
	const stream = event.data?.after?.data?.();
	// If stream is undefined, it means the document is deleted
	if (stream === undefined) {
		return;
	}

	// Denormalize objectTypes
	const objects = stream.object ?? [];
	// eslint-disable-next-line private-props/no-use-outside, no-underscore-dangle
	const oldObjectTypes = new Set<string>(stream._meta?.objectTypes ?? []);
	const newObjectTypes = new Set<string>(objects.map((object: any) => object.type));

	if (!setEqual(oldObjectTypes, newObjectTypes)) {
		await event.data?.after?.ref?.update?.({
			'_meta.objectTypes': Array.from(newObjectTypes),
		});
	}
});
