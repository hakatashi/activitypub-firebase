import './init.js';
import firebase from 'firebase-admin';
import { getInstallations } from 'firebase-admin/installations';

export { FUNCTION_REGION, taskQueueName } from './init.js';

export const app = firebase.initializeApp();
const isTestOrEmulator =
	process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'test';
if (!app.options.serviceAccountId && process.env.GCLOUD_PROJECT && !isTestOrEmulator) {
	app.options.serviceAccountId = `${process.env.GCLOUD_PROJECT}@appspot.gserviceaccount.com`;
}
export const db = firebase.firestore();
export const projectId = getInstallations().app.options.projectId;
export const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';
export const mastodonDomain =
	projectId === 'activitypub-firebase' ? 'mastodon.hakatashi.com' : 'mastodon-dev.hakatashi.com';

declare const firestoreKeyBrand: unique symbol;
export type FirestoreKey = string & { readonly [firestoreKeyBrand]: true };

export const escapeFirestoreKey = (key: string): FirestoreKey =>
	key.replaceAll(/%/g, '%25').replaceAll(/\//g, '%2F').replaceAll(/\./g, '%2E') as FirestoreKey;

export const unescapeFirestoreKey = (key: FirestoreKey) => decodeURIComponent(key);

// Firestore から読み出したドキュメント ID (doc.id) など、すでにエスケープ済みである文字列を
// FirestoreKey として扱うための変換 (→ ADR-0027)。
// 生の IRI には使わず、必ず escapeFirestoreKey() を使うこと。
export const toFirestoreKey = (key: string): FirestoreKey => key as FirestoreKey;
