// apex フォーク (functions/src/apex) に対する本体側の型拡張。
// フォーク本体は Firebase や本体コードに依存しない (ADR-0042) ため、
// _meta や DeliveryRecord などのプロジェクト固有の型はここで declaration merging する。

import type { ObjectMeta } from '../src/meta.js';
import type { DeliveryRecord } from '../src/schema.js';

declare module '../src/apex/index.js' {
	namespace ActivitypubExpress {
		export interface APObject {
			_meta?: ObjectMeta;
		}

		export interface ApexStore {
			getFailedDeliveries(): Promise<DeliveryRecord[]>;
			getDelivery(activityId: string, address: string): Promise<DeliveryRecord | undefined>;
		}
	}
}
