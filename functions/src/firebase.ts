import firebase from 'firebase-admin';
import {getInstallations} from 'firebase-admin/installations';

export const app = firebase.initializeApp();
export const db = firebase.firestore();
export const projectId = getInstallations().app.options.projectId;
export const domain = projectId === 'activitypub-firebase'
	? 'hakatashi.com'
	: 'activitypub-dev.hakatashi.com';