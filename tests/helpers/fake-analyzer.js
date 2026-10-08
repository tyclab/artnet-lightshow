// NDJSON worker fixture; FAKE_MODE selects success, hangs, crashes, malformed replies or GPU faults.
// hangslow delays "late" inputs and never answers "slow" inputs to exercise worker recycling.
import readline from 'node:readline';

const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'exitnow') process.exit(3);
const rl = readline.createInterface({ input: process.stdin });
let served = 0;

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (mode === 'hang') return;
  if (mode === 'hangslow' && String(req.source).includes('slow')) return;
  if (mode === 'hangslow' && String(req.source).includes('late')) {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: req.id, result: { bpm: 128, source: req.source, pid: process.pid } }) + '\n');
    }, 300);
    return;
  }
  if (mode === 'nanreply') {
    process.stdout.write(`{"id": ${req.id}, "result": {"bpm": NaN}}\n`);
    return;
  }
  if (mode === 'crash') process.exit(1);
  if (mode === 'env') {
    process.stdout.write(JSON.stringify({ id: req.id, result: { separator: process.env.ARTNET_USE_BS_ROFORMER, structure: process.env.ARTNET_STRUCTURE_MODEL, gpuMemory: process.env.ARTNET_GPU_MEMORY, pid: process.pid } }) + '\n');
    return;
  }
  if (mode === 'gpufault') {
    if (served++) process.exit(1);
    process.stdout.write(JSON.stringify({ id: req.id, result: { pid: process.pid }, recycle: true }) + '\n');
    return;
  }
  const id = mode === 'wrongid' ? req.id + 999 : req.id;
  process.stdout.write(JSON.stringify({ id, result: { bpm: 128, source: req.source } }) + '\n');
});
