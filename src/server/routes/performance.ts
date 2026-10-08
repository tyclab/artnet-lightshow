import type { Express } from 'express';
import type { RouteContext } from './common.ts';
import { generatePlaylist, PLAYLIST_TEMPLATES } from '../playlist-generator.ts';
import { hardwareOf } from '../../shared/hardware.ts';
import { state } from '../state.ts';
import { getProfile } from '../profiles.ts';
import { settings } from '../settings.ts';
import { z } from 'zod';
import { validate } from '../validation.ts';

const automationRequest = z.object({ axis: z.enum(['tempo', 'brightness']), settings: z.unknown() }).strict();

export function attachPerformanceRoutes(app: Express, ctx: RouteContext): void {
  app.get('/api/performance/automation', (_req, res) => res.json({ ok: true, automation: ctx.integrations.liveAutomation.status() }));
  app.put('/api/performance/automation', (req, res) => {
    const body = validate(automationRequest, req.body, 'live automation');
    ctx.integrations.liveAutomation.start(body.axis, body.settings);
    ctx.integrations.broadcast();
    res.json({ ok: true, automation: ctx.integrations.liveAutomation.status() });
  });
  app.delete('/api/performance/automation', (_req, res) => {
    ctx.integrations.liveAutomation.stop();
    ctx.integrations.broadcast();
    res.json({ ok: true, automation: ctx.integrations.liveAutomation.status() });
  });
  app.get('/api/sequence/generator', (_req, res) => res.json({ ok: true, templates: PLAYLIST_TEMPLATES }));
  app.post('/api/sequence/generator', (req, res) => {
    const { builtin, user } = ctx.integrations.library.effects.list();
    const caps = state.fixtures.map((fixture) => hardwareOf(fixture, getProfile(fixture), settings.group('hardware')));
    const result = generatePlaylist(req.body, [...builtin, ...user], caps, state.bpm);
    result.sequence.performance = {
      master: { ...(ctx.integrations.sequence.sequencer.performance()?.master ?? settings.get('audio.master')) },
      pads: ctx.integrations.pads.store.layout(), activePadLayoutId: ctx.integrations.pads.store.activeLayoutId(),
    };
    res.json({ ok: true, ...result });
  });
  app.get('/api/performance/input', (_req, res) => {
    res.json({ ok: true, ...ctx.integrations.audio.captureInput() });
  });
}
