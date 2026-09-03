import {getFunctions} from 'firebase-admin/functions';
import {logger} from 'firebase-functions/v2';
import {onTaskDispatched} from 'firebase-functions/v2/tasks';

interface PingTaskPayload {
	message: string;
}

export const pingTask = onTaskDispatched<PingTaskPayload>(
	{retryConfig: {maxAttempts: 1}},
	(request) => {
		logger.info({type: 'pingTaskReceived', message: request.data.message});
	},
);

export const enqueuePingTask = async (message: string) => {
	await getFunctions().taskQueue('pingTask').enqueue({message});
};
