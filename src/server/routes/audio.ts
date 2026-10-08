import { z } from 'zod';
import { validate } from '../validation.ts';
import { settings, schema } from '../settings.ts';
import { HttpError, messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';

const audio = schema.shape.audio.shape;

const audioPatchSchema = z.object({
  mode: audio.mode.optional(),
  master: audio.master.partial().strict().optional(),
  ldjTrigger: audio.ldjTrigger.optional(),
  scopeId: z.string().min(1).max(64).nullable().optional(),
}).strict();

export function attachAudioRoutes(app: Express, ctx: RouteContext): void {
  const { integrations, applier } = ctx;

  app.get('/api/audio', (_req, res) => res.json({ ok: true, ...integrations.audio.summary() }));

  app.put('/api/audio', (req, res) => {
    try {
      const body = validate(audioPatchSchema, req.body ?? {}, 'audio');
      const seq = integrations.sequence.sequencer.current();
      if (Object.hasOwn(body, 'scopeId') && body.scopeId !== (seq?.performance ? seq.id : null)) {
        throw new HttpError(409, 'The audio setup changed to another show. Discard or reapply your edits to the intended show.');
      }
      const scoped = !!(seq?.performance && body.master);
      const prepared = scoped ? integrations.sequence.sequencer.prepareLoad({ ...seq, performance: {
        ...seq!.performance!, master: { ...seq!.performance!.master, ...body.master },
      } }) : null;
      const { master: _master, scopeId: _scope, ...globals } = body;
      const patch = scoped ? globals : { ...globals, ...(body.master ? { master: { ...settings.get('audio.master'), ...body.master } } : {}) };
      const changed = settings.update({ audio: patch });
      if (prepared) integrations.sequence.sequencer.commitPrepared(prepared);
      applier.applyChanged(changed);
      integrations.broadcast();
      res.json({ ok: true, changed, settings: integrations.audio.summary(), detectors: integrations.audio.detectors() });
    } catch (err) {
      res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }
  });
}
