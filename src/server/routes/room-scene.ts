import type { Express, Request, Response } from 'express';
import { roomSceneSchema } from '../../shared/room-scene.ts';
import { RoomSceneStore, sharedRoomScene } from '../room-scene-store.ts';
import { currentRig } from '../rig.ts';
import { buildUnitSpace, spaceReport } from '../../shared/space.ts';
import type { Rig } from '../../shared/rig.ts';

export function attachRoomSceneRoutes(app: Express, suppliedStore?: RoomSceneStore, rigOf: () => Rig = currentRig): void {
  let store = suppliedStore;
  const current = () => (store ??= sharedRoomScene());
  const matches = (value: string | undefined, revision: string) => value === revision || value === `"${revision}"`;
  const response = (res: Response) => {
    const snapshot = current().snapshot();
    res.set('ETag', `"${snapshot.revision}"`);
    res.set('Cache-Control', 'private, no-cache');
    return snapshot;
  };
  const precondition = (req: Request, res: Response) => {
    if (!req.headers['if-match']) {
      res.status(428).json({ ok: false, error: 'Load the current room before replacing it (If-Match required).' });
      return false;
    }
    if (!matches(req.headers['if-match'], current().snapshot().revision)) {
      res.status(412).json({ ok: false, error: 'The room changed in another session. Reload it before replacing it.' });
      return false;
    }
    return true;
  };

  app.get('/api/stage/room', (req, res) => {
    const snapshot = response(res);
    if (matches(req.headers['if-none-match'], snapshot.revision)) return res.status(304).end();
    res.json({ ok: true, ...snapshot });
  });
  // Read-only: where the effects place each unit, against the bindings and the Rig plot.
  app.get('/api/stage/room/report', (_req, res) => {
    const { room, revision } = current().peek();
    const rig = rigOf();
    const space = buildUnitSpace(rig, room);
    res.set('Cache-Control', 'private, no-cache');
    res.json({ ok: true, revision, units: space.n, ...spaceReport(rig, room, space) });
  });
  app.put('/api/stage/room', (req, res) => {
    if (!precondition(req, res)) return;
    const parsed = roomSceneSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'Invalid room scene', issues: parsed.error.issues });
    current().replace(parsed.data);
    res.json({ ok: true, ...response(res) });
  });
  app.delete('/api/stage/room', (req, res) => {
    if (!precondition(req, res)) return;
    current().replace(null);
    res.json({ ok: true, ...response(res) });
  });
}
