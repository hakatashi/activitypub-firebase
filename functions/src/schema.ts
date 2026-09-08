import type {
	CollectionReference as GoogleCollectionReference,
	DocumentReference,
	Timestamp,
} from '@google-cloud/firestore';
import type { APObject } from './apex/index.js';
import type {
	AuthorizationCode,
	Client,
	RefreshToken,
	Token,
	User,
} from '@node-oauth/oauth2-server';
import type { mastodon } from 'masto';
import { db } from './firebase.js';
import type { FirestoreKey } from './firebase.js';
import type { CamelToSnake } from './utils.js';

// Firestore のコレクション参照とスキーマ型はここに集約する (→ ADR-0023)。
// 他のファイルは `db.collection(...)` を直接呼ばず、ここで定義した名前付き
// `CollectionReference` だけを使う。

export type CollectionReference<T> = Omit<GoogleCollectionReference<T>, 'doc'> & {
	doc(): DocumentReference<T>;
	doc(documentPath: FirestoreKey): DocumentReference<T>;
};

export type UserInfo = Pick<
	CamelToSnake<mastodon.v1.Account>,
	| 'id'
	| 'locked'
	| 'bot'
	| 'created_at'
	| 'followers_count'
	| 'following_count'
	| 'statuses_count'
	| 'last_status_at'
	| 'emojis'
	| 'fields'
	| 'roles'
> & {
	uid: string | null;
};

export const UserInfos = db.collection('userInfos') as CollectionReference<UserInfo>;

export interface MastodonClient extends Client {
	clientId: string;
	clientSecret: string;
	vapidKey: string;
	name: string;
	scopes: string[];
	userId?: string;
}

export const AccessTokens = db.collection('accessTokens') as CollectionReference<Token>;
export const RefreshTokens = db.collection('refreshTokens') as CollectionReference<RefreshToken>;
export const AuthorizationCodes = db.collection(
	'authorizationCodes',
) as CollectionReference<AuthorizationCode>;
export const Clients = db.collection('clients') as CollectionReference<MastodonClient>;
export const Users = db.collection('users') as CollectionReference<
	User & { username: string; password: string }
>;

// `deliveries` (→ ADR-0012)。`recordDeliveryResult` は `updatedAt` に
// `FieldValue.serverTimestamp()` を書き込むが、読み出し時は `Timestamp` になる。
// `WithFieldValue<T>`/`UpdateData<T>` が書き込み側の `FieldValue` を自動的に許容するため、
// 読み型をそのまま `CollectionReference` の型引数にできる(→ ADR-0023 決定5)。
export interface DeliveryRecord {
	activityId: string;
	actorId: string;
	inbox: string;
	body: string;
	attempts: number;
	status: 'permanent_failure' | 'retrying' | 'success';
	statusCode: number | null;
	error: string | null;
	updatedAt: Timestamp;
}

export const Deliveries = db.collection('deliveries') as CollectionReference<DeliveryRecord>;

export interface StoredContext {
	contextUrl: string | null;
	documentUrl: string;
	document: string;
}

export const Contexts = db.collection('contexts') as CollectionReference<StoredContext>;

export const Objects = db.collection('objects') as CollectionReference<APObject>;
export const Streams = db.collection('streams') as CollectionReference<APObject>;
