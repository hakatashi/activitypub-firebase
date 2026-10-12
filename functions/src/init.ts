import { setGlobalOptions } from 'firebase-functions/v2';

export const FUNCTION_REGION = 'asia-northeast1';

setGlobalOptions({ region: FUNCTION_REGION });

export const taskQueueName = (name: string): string =>
	`locations/${FUNCTION_REGION}/functions/${name}`;
