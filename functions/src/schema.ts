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

// フォロー関係の射影 (→ ADR-0082)。`userInfos/{ローカル actor}/following|followers/{相手}`。
export type FollowRelationSide = 'followers' | 'following';
export type FollowState = 'pending' | 'accepted';

// 相手への生きている Follow 1 件分。
export interface FollowRelationEntry {
	iri: string;
	state: FollowState;
	mastodonId: string | null;
}

export interface FollowRelation {
	// 相手の actor IRI
	actor: string;
	// 代表の Follow (承認済みを優先し、同順位なら Mastodon ID が最大のもの)
	followIri: string;
	followMastodonId: string | null;
	// followers は常に 'accepted'
	state: FollowState;
	createdAt: Timestamp;
	follows: FollowRelationEntry[];
}

export const FollowRelations = (userInfoKey: FirestoreKey, side: FollowRelationSide) =>
	UserInfos.doc(userInfoKey).collection(side) as CollectionReference<FollowRelation>;

// お気に入り・ブーストの射影 (→ ADR-0084)。`userInfos/{ローカル actor}/favourites|reblogs/{Note}`。
export type ReactionKind = 'favourites' | 'reblogs';

export interface ReactionRelation {
	// 対象の Note IRI
	object: string;
	// その Note への生きている Like / Announce の IRI
	activityIris: string[];
	// 一覧のカーソル。activityIris の Mastodon ID の最大値 (未採番なら null。→ ADR-0099)
	cursorId: string | null;
	createdAt: Timestamp;
}

export const ReactionRelations = (userInfoKey: FirestoreKey, kind: ReactionKind) =>
	UserInfos.doc(userInfoKey).collection(kind) as CollectionReference<ReactionRelation>;

// ブックマーク (→ ADR-0070, ADR-0099)。`userInfos/{ローカル actor}/bookmarks/{Note}`。
export interface Bookmark {
	noteIri: string;
	// 一覧のカーソル。ブックマーク時刻から作る Mastodon ID 形式の値 (→ ADR-0099)
	cursorId: string;
	createdAt: Timestamp;
}

export const Bookmarks = (userInfoKey: FirestoreKey) =>
	UserInfos.doc(userInfoKey).collection('bookmarks') as CollectionReference<Bookmark>;

// 通知の射影 (→ ADR-0088)。`userInfos/{ローカル actor}/notifications/{アクティビティ IRI}`。
export type NotificationType = 'mention' | 'favourite' | 'reblog' | 'follow';

export interface NotificationRecord {
	// 通知 ID (アクティビティの Mastodon ID。時系列順)
	id: string;
	type: NotificationType;
	activityIri: string;
	accountIri: string;
	statusIri: string | null;
	createdAt: Timestamp;
}

export const Notifications = (userInfoKey: FirestoreKey) =>
	UserInfos.doc(userInfoKey).collection('notifications') as CollectionReference<NotificationRecord>;

export interface MastodonClient extends Client {
	clientId: string;
	clientSecret: string;
	vapidKey: string;
	name: string;
	scopes: string[];
	userId?: string;
	website?: string;
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

// Mastodon API の ID と AP IRI の相互マッピング (→ ADR-0006、ADR-0058)。
// 両方向のドキュメントは `functions/src/mastodonId.ts` が同一トランザクションで書き込む。
// `mastodonIds` のドキュメント ID (= Mastodon ID) が一意性の鍵になる。
export interface MastodonIdRecord {
	iri: string;
}

export interface MastodonIdByIriRecord {
	mastodonId: string;
}

export const MastodonIds = db.collection('mastodonIds') as CollectionReference<MastodonIdRecord>;
export const MastodonIdsByIri = db.collection(
	'mastodonIdsByIri',
) as CollectionReference<MastodonIdByIriRecord>;

// `POST /api/v1/statuses` の `Idempotency-Key` (→ ADR-0063)。ドキュメント ID は
// `functions/src/idempotency.ts` が actor とキーから導出する。`expiresAt` は TTL ポリシーの対象。
export interface IdempotencyKeyRecord {
	actorId: string;
	noteIri: string;
	expiresAt: Timestamp;
}

export const IdempotencyKeys = db.collection(
	'idempotencyKeys',
) as CollectionReference<IdempotencyKeyRecord>;

// `/api/v1/markers` の既読位置マーカー (→ ADR-0067)。ドキュメント ID は
// `${escapeFirestoreKey(actorId)}_${timeline}`。
export interface MarkerRecord {
	actorId: string;
	timeline: 'home' | 'notifications';
	lastReadId: string;
	version: number;
	updatedAt: Timestamp;
}

export const Markers = db.collection('markers') as CollectionReference<MarkerRecord>;

// メディア添付レコード (→ ADR-0091)。`mediaAttachments/{Mastodon ID}`。
export interface MediaAttachmentMetaDimensions {
	width: number;
	height: number;
	size: string;
	aspect: number;
}

export interface MediaAttachmentMeta {
	original?: MediaAttachmentMetaDimensions;
	small?: MediaAttachmentMetaDimensions;
	focus?: {
		x: number;
		y: number;
	};
}

export interface MediaAttachmentRecord {
	id: string;
	actorId: string;
	type: 'image';
	storagePath: string;
	previewStoragePath: string;
	url: string;
	previewUrl: string;
	remoteUrl: string | null;
	textUrl: string | null;
	mimeType: string;
	meta: MediaAttachmentMeta;
	description: string;
	blurhash: string;
	statusIri: string | null;
	createdAt: Timestamp;
	updatedAt: Timestamp;
}

export const MediaAttachments = db.collection(
	'mediaAttachments',
) as CollectionReference<MediaAttachmentRecord>;
