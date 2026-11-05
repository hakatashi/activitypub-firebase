import './init.js';
import type { AppOptions } from 'firebase-admin/app';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getInstallations } from 'firebase-admin/installations';
import { resolveInstanceConfig } from './instanceConfig.js';

export { FUNCTION_REGION, taskQueueName } from './init.js';

const isTestOrEmulator =
	process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'test';
const appOptions: AppOptions = {};
const projectIdEnv = process.env.GCLOUD_PROJECT;
if (projectIdEnv) {
	appOptions.projectId = projectIdEnv;
}
if (!isTestOrEmulator) {
	const defaultProjectId = projectIdEnv ?? 'activitypub-firebase-dev';
	appOptions.serviceAccountId = `${defaultProjectId}@appspot.gserviceaccount.com`;
}
export const app = initializeApp(appOptions);
export const db = getFirestore(app);
export const projectId = getInstallations().app.options.projectId;
export const instanceConfig = resolveInstanceConfig(projectId);
export const { domain, mastodonDomain } = instanceConfig;

declare const firestoreKeyBrand: unique symbol;
export type FirestoreKey = string & { readonly [firestoreKeyBrand]: true };

export const escapeFirestoreKey = (key: string): FirestoreKey =>
	key.replaceAll(/%/g, '%25').replaceAll(/\//g, '%2F').replaceAll(/\./g, '%2E') as FirestoreKey;

export const unescapeFirestoreKey = (key: FirestoreKey) => decodeURIComponent(key);

// Firestore から読み出したドキュメント ID (doc.id) など、すでにエスケープ済みである文字列を
// FirestoreKey として扱うための変換 (→ ADR-0027)。
// 生の IRI には使わず、必ず escapeFirestoreKey() を使うこと。
export const toFirestoreKey = (key: string): FirestoreKey => key as FirestoreKey;
