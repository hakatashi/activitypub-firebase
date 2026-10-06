// 配送タスクの発行と、tasks.ts の配送タスクが記録する配送結果 (→ ADR-0003、ADR-0012)。
import firebase from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { escapeFirestoreKey } from '../firebase.js';
import { Deliveries } from '../schema.js';

export interface DeliveryResult {
	activityId: string;
	actorId: string;
	address: string;
	body: string;
	attempts: number;
	status: 'permanent_failure' | 'retrying' | 'success';
	statusCode?: number;
	error?: string;
}

// 受信者1件につき1つの Cloud Tasks タスクを発行する (→ ADR-0003)。
// 秘密鍵はタスクペイロードに載せない。ワーカー側で actorId から鍵を引く。
export const enqueueDeliveryTasks = async (actorId: string, body: string, addresses: string[]) => {
	await Promise.all(
		addresses.map((address) =>
			getFunctions().taskQueue('deliveryTask').enqueue({ actorId, body, address }),
		),
	);
};

// → ADR-0012
const deliveryDocId = (activityId: string, address: string) =>
	escapeFirestoreKey(`${activityId} ${address}`);

// → ADR-0012
export const recordDeliveryResult = async ({
	activityId,
	actorId,
	address,
	body,
	attempts,
	status,
	statusCode,
	error,
}: DeliveryResult) => {
	logger.info({
		type: 'recordDeliveryResult',
		activityId,
		actorId,
		address,
		attempts,
		status,
		statusCode,
	});

	await Deliveries.doc(deliveryDocId(activityId, address)).set({
		activityId,
		actorId,
		inbox: address,
		body,
		attempts,
		status,
		statusCode: statusCode ?? null,
		error: error ?? null,
		updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
	});
};

// → ADR-0012
export const getFailedDeliveries = async () => {
	const snapshot = await Deliveries.where('status', 'in', ['permanent_failure', 'retrying']).get();

	return snapshot.docs.map((doc) => doc.data());
};

// → ADR-0012
export const getDelivery = async (activityId: string, address: string) => {
	const doc = await Deliveries.doc(deliveryDocId(activityId, address)).get();
	return doc.exists ? doc.data() : undefined;
};
