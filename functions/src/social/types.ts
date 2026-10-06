import type { APNote } from 'activitypub-types';
import type { APObject as ApexObject } from '../apex/index.js';

export type NoteObject = ApexObject & APNote;
