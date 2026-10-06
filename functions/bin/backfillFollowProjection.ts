import { apex } from '../src/apex.js';
import { escapeFirestoreKey } from '../src/firebase.js';
import { localActorId } from '../src/localActor.js';
import { rebuildFollowProjection } from '../src/projections/follows.js';
import { FollowRelations } from '../src/schema.js';
import { collectFollowers, resolveOutgoingFollows } from '../src/social/follows.js';
import { isAPActor } from '../src/utils.js';

// フォロー関係の射影 (`userInfos/{actor}/followers|following`) とカウンタを、streams の Follow から
// 組み立て直すバックフィル (→ ADR-0082)。何度実行してもよい。`--dry-run` で書き込まずに差分だけ出す。
// 最後に、既存の関数 (collectFollowers / resolveOutgoingFollows) の結果と突き合わせて差分を出力する。
// 既存の関数は `_meta.index` を引くので、bin/denormalizations.ts で index が揃っている前提。

const dryRun = process.argv.includes('--dry-run');

const stats = await rebuildFollowProjection({ dryRun });
console.log({ dryRun, ...stats });

const actor = await apex.store.getObject(localActorId);
if (actor === undefined || !isAPActor(actor)) {
	throw new Error(`local actor not found: ${localActorId}`);
}
const userInfoKey = escapeFirestoreKey(localActorId);
const [followerDocs, followingDocs, legacyFollowers, legacyOutgoing] = await Promise.all([
	FollowRelations(userInfoKey, 'followers').get(),
	FollowRelations(userInfoKey, 'following').get(),
	collectFollowers(actor),
	resolveOutgoingFollows(actor),
]);

const diff = (label: string, projected: Set<string>, legacy: Set<string>) => {
	const onlyProjected = [...projected].filter((iri) => !legacy.has(iri));
	const onlyLegacy = [...legacy].filter((iri) => !projected.has(iri));
	console.log(`${label}: projection=${projected.size} legacy=${legacy.size}`);
	if (onlyProjected.length > 0) {
		console.log(`  only in projection: ${onlyProjected.join(', ')}`);
	}
	if (onlyLegacy.length > 0) {
		console.log(`  only in legacy: ${onlyLegacy.join(', ')}`);
	}
};

const following = followingDocs.docs.map((doc) => doc.data());
diff(
	'followers',
	new Set(followerDocs.docs.map((doc) => doc.data().actor)),
	new Set(legacyFollowers.keys()),
);
diff(
	'following (accepted)',
	new Set(following.filter(({ state }) => state === 'accepted').map(({ actor: iri }) => iri)),
	new Set(legacyOutgoing.following.keys()),
);
diff(
	'following (pending)',
	new Set(following.filter(({ state }) => state === 'pending').map(({ actor: iri }) => iri)),
	new Set([...legacyOutgoing.pending].filter((iri) => !legacyOutgoing.following.has(iri))),
);
