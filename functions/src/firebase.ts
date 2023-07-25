import firebase from 'firebase-admin';
import {getInstallations} from 'firebase-admin/installations';

export const app = firebase.initializeApp();
export const db = firebase.firestore();
export const projectId = getInstallations().app.options.projectId;
export const domain = projectId === 'activitypub-firebase'
	? 'hakatashi.com'
	: 'activitypub-dev.hakatashi.com';
export const mastodonDomain = projectId === 'activitypub-firebase'
	? 'mastodon.hakatashi.com'
	: 'mastodon-dev.hakatashi.com';

export const escapeFirestoreKey = (key: string) => (
	key
		.replaceAll(/%/g, '%25')
		.replaceAll(/\//g, '%2F')
		.replaceAll(/\./g, '%2E')
);
