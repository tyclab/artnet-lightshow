import { createHash } from 'node:crypto';
import { JsonStore } from './json-store.ts';
import { configFile } from './config-dir.ts';
import { roomSceneSchema } from '../shared/room-scene.ts';
import type { RoomScene } from '../shared/room-scene.ts';

export class RoomSceneStore extends JsonStore {
  declare _room: RoomScene | null;
  declare _revision: string;

  constructor(file = configFile('stage-room.json')) {
    super(file, { tag: 'stage room', fallback: 'using the generic stage', mode: 0o600 });
    this._room = null;
    this._revision = 'empty';
  }

  useDefaults(): void {
    this._room = null;
    this._revision = 'empty';
  }

  load(): this {
    this.publish(this.readValid(roomSceneSchema.nullable()) ?? null);
    return this;
  }

  snapshot(): { room: RoomScene | null; revision: string } {
    return { room: structuredClone(this._room), revision: this._revision };
  }

  replace(raw: unknown): void {
    const room = roomSceneSchema.nullable().parse(raw);
    this.writeJson(room);
    this.publish(room);
  }

  private publish(room: RoomScene | null): void {
    this._room = room;
    this._revision = room === null ? 'empty' : createHash('sha256').update(JSON.stringify(room)).digest('hex');
  }
}
