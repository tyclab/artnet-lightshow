import { z } from 'zod';
import { state } from '../state.ts';
import { settings } from '../settings.ts';
import { newUserId } from '../effect-library.ts';
import { capturePadLayout, previewPadLayout } from '../pad-layouts.ts';
import { HttpError } from '../../errors.ts';
import { validate } from '../validation.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';
import type { PadContent } from '../../shared/party-setup.ts';

const expectedSchema = z.object({ id: z.string().nullable(), revision: z.number().int().nonnegative(), padsRevision: z.number().int().nonnegative() }).strict();
const nameSchema = z.string().trim().min(1).max(80);
const mapSchema = z.array(z.number().int().nonnegative().nullable()).max(1024).optional();
const applySchema = z.object({ expected: expectedSchema, mapping: mapSchema, allowMissingContent: z.boolean().optional() }).strict();

export function attachShowSetupRoutes(app: Express, ctx: RouteContext): void {
  const { sequence, pads, library } = ctx.integrations;
  const current = () => sequence.sequencer.current();
  const expected = () => ({ id: sequence.sequencer.status().loaded?.id ?? null, revision: sequence.sequencer.status().revision, padsRevision: pads.store.revision });
  const check = (want: z.infer<typeof expectedSchema>) => {
    const actual = expected();
    if (want.id !== actual.id || want.revision !== actual.revision || want.padsRevision !== actual.padsRevision) throw new HttpError(409, 'The show or pad deck changed. Refresh this setup before applying it.');
  };
  const idleTake = () => {
    if (sequence.sequencer.recording()) throw new HttpError(409, 'Review or discard the recorded take before replacing the pad setup.');
  };
  const fixtures = () => state.fixtures.map(({ id, label }) => ({ id, label }));
  const order = () => {
    const tracks = current()?.lanes.filter((lane) => lane.kind === 'track') ?? [];
    const patched = fixtures();
    return tracks.length ? tracks.map((lane) => ({ id: lane.fixtureId!, label: patched.find((fixture) => fixture.id === lane.fixtureId)?.label ?? `Missing fixture ${lane.fixtureId}` })) : patched;
  };
  const effective = () => ({ master: { ...(sequence.sequencer.performance()?.master ?? settings.get('audio.master')) },
    pads: pads.store.layout(), activePadLayoutId: pads.store.activeLayoutId() });
  const exists = (content: PadContent) => content.kind === 'strobe' ? content.id === 'strobe'
    : content.kind === 'preset' ? !!library.effects.resolve(content.id) : !!sequence.store.getPattern(content.id);
  const get = (id: string) => {
    const layout = sequence.store.padLayout(id);
    if (!layout) throw new HttpError(404, 'No such pad layout');
    return layout;
  };
  const snapshot = () => ({ expected: expected(), scoped: !!sequence.sequencer.performance(), performance: effective(), fixtures: fixtures(), order: order(),
    orderMode: current()?.lanes.some((lane) => lane.kind === 'track') ? 'show tracks' : 'rig fixtures',
    layouts: sequence.store.padLayouts().map(({ id, name }) => ({ id, name })) });

  app.get('/api/show-setup', (_req, res) => res.json({ ok: true, ...snapshot() }));
  app.post('/api/sequence/setup', (req, res) => {
    const body = validate(z.object({ expected: expectedSchema, action: z.enum(['capture', 'global']) }).strict(), req.body, 'show setup');
    check(body.expected); idleTake();
    const seq = current();
    if (!seq) throw new HttpError(409, 'Load a sequence before saving its setup');
    if (body.action === 'capture') seq.performance = effective();
    else delete seq.performance;
    const saved = sequence.sequencer.load(seq);
    ctx.integrations.broadcast();
    res.json({ ok: true, sequence: saved, status: sequence.sequencer.status(), ...snapshot() });
  });

  app.get('/api/pad-layouts', (_req, res) => res.json({ ok: true, layouts: sequence.store.padLayouts() }));
  app.get('/api/pad-layouts/:id', (req, res) => res.json({ ok: true, layout: get(req.params.id) }));
  app.post('/api/pad-layouts', (req, res) => {
    const body = validate(z.object({ name: nameSchema, expected: expectedSchema }).strict(), req.body, 'pad layout');
    check(body.expected);
    let id = newUserId();
    while (sequence.store.padLayout(id)) id = newUserId();
    const layout = capturePadLayout(pads.store.layout(), order(), id, body.name);
    const seq = current();
    const prepared = seq?.performance ? sequence.sequencer.prepareLoad({ ...seq, performance: { ...seq.performance, activePadLayoutId: id } }) : null;
    sequence.store.savePadLayout(layout);
    if (prepared) sequence.sequencer.commitPrepared(prepared);
    ctx.integrations.broadcast();
    res.status(201).json({ ok: true, layout });
  });
  app.put('/api/pad-layouts/:id', (req, res) => {
    const before = get(req.params.id);
    const body = validate(z.object({ name: nameSchema, capture: z.boolean().optional(), expected: expectedSchema }).strict(), req.body, 'pad layout');
    check(body.expected);
    const layout = body.capture ? capturePadLayout(pads.store.layout(), order(), before.id, body.name) : { ...before, name: body.name };
    res.json({ ok: true, layout: sequence.store.savePadLayout(layout) });
  });
  app.delete('/api/pad-layouts/:id', (req, res) => {
    get(req.params.id);
    const body = validate(z.object({ expected: expectedSchema }).strict(), req.body, 'pad layout');
    check(body.expected);
    const seq = current();
    const prepared = seq?.performance?.activePadLayoutId === req.params.id
      ? sequence.sequencer.prepareLoad({ ...seq, performance: { ...seq.performance, activePadLayoutId: null } }) : null;
    sequence.store.removePadLayout(req.params.id);
    if (prepared) sequence.sequencer.commitPrepared(prepared);
    ctx.integrations.broadcast();
    res.json({ ok: true });
  });
  app.post('/api/pad-layouts/:id/preview', (req, res) => {
    const body = validate(z.object({ mapping: mapSchema }).strict(), req.body ?? {}, 'pad layout mapping');
    const layout = get(req.params.id);
    res.json({ ok: true, layout, ...snapshot(), preview: previewPadLayout(layout, order(), exists, body.mapping) });
  });
  app.post('/api/pad-layouts/:id/apply', (req, res) => {
    const body = validate(applySchema, req.body, 'pad layout');
    check(body.expected); idleTake();
    const layout = get(req.params.id);
    const preview = previewPadLayout(layout, order(), exists, body.mapping);
    if (preview.missingSlots.length) throw new HttpError(409, `Map fixture slots ${preview.missingSlots.map((slot) => slot + 1).join(', ')} before applying this layout`);
    if (preview.missingContent.length && !body.allowMissingContent) {
      return res.status(409).json({ ok: false, error: 'Some saved pad content is missing. Review the unassigned pads before applying.', preview });
    }
    pads.store.replace(preview.pads, layout.id);
    pads.stopAll();
    ctx.integrations.broadcast();
    res.json({ ok: true, ...snapshot(), missingContent: preview.missingContent });
  });
}
