// @ts-expect-error: Not typed
import * as IApexStore from 'activitypub-express/store/interface';

// Implements IApexStore:
// https://github.com/immers-space/activitypub-express/blob/master/store/interface.js
export default class Store extends IApexStore {
	db: null;

	constructor() {
		super();
		this.db = null;
	}
}
