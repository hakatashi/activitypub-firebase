import type {Firestore} from '@google-cloud/firestore';
// @ts-expect-error: Not typed
import * as IApexStore from 'activitypub-express/store/interface';
import * as firebase from 'firebase-admin';
import {logger} from 'firebase-functions/v1';

firebase.initializeApp();

const escapeFirestoreKey = (key: string) => (
	key
		.replaceAll(/%/g, '%25')
		.replaceAll(/\//g, '%2F')
		.replaceAll(/\./g, '%2E')
);

// const unescapeFirestoreKey = (key: string) => decodeURIComponent(key);

// Implements IApexStore:
// https://github.com/immers-space/activitypub-express/blob/master/store/interface.js
export default class Store extends IApexStore {
	db: Firestore;

	constructor() {
		super();
		this.db = firebase.firestore();
	}

	setup(optionalActor?: string) {
		logger.info('setup');
	}

	async getObject(id: string, includeMeta?: boolean) {
		const objectDoc = await this.db.collection('objects').doc(escapeFirestoreKey(id)).get();

		if (!objectDoc.exists) {
			return undefined;
		}

		const object = objectDoc.data()!;

		if (includeMeta !== true) {
			delete object.meta;
		}

		return object;
	}
}
