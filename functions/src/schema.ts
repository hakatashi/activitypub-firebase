import type {CollectionReference} from '@google-cloud/firestore';
import type {mastodon} from 'masto';
import {db} from './firebase.js';
import type {CamelToSnake} from './mastodon/utils.js';

type UserInfo = Pick<
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
	uid: string,
};

export const UserInfos = db.collection('userInfos') as CollectionReference<UserInfo>;
