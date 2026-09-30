import type { Apex } from '../types.js';

export const generateNodeInfo = async function (this: Apex, version: string) {
	return {
		version,
		software: {
			name: `${this.settings.name}`,
			version: `${this.settings.version}`,
		},
		protocols: ['activitypub'],
		services: { inbound: [], outbound: [] },
		openRegistrations: Boolean(this.settings.openRegistrations),
		usage: { users: { total: await this.store.getUserCount() } },
		metadata: this.settings.nodeInfoMetadata ?? {},
	};
};
