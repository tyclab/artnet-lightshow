// Check native TypeScript support before loading the server.
if (!process.features?.typescript) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const recentEnough = major > 22 || (major === 22 && minor >= 18);
  console.error(recentEnough
    ? `artnet-lightshow runs its TypeScript directly, and this Node (${process.version}) has that turned off. `
      + 'Check NODE_OPTIONS and the command line for --no-experimental-strip-types.'
    : `artnet-lightshow needs Node.js 22.18 or newer, which runs TypeScript directly. `
      + `This is Node ${process.version}. Install the current LTS from https://nodejs.org/ and run it again.`);
  process.exit(1);
}

// The .env in the folder it starts from, first: it can say where the config
// is (whose Deezer ARL the supervisor looks for) and turn the supervisor off.
await import('./src/load-env.ts');

// Avoid nested supervisors when another process or Node watch owns restarts.
const direct = process.env.LIGHTSHOW_SUPERVISED === '1'
  || process.env.LIGHTSHOW_SUPERVISOR === '0'
  || process.argv.includes('--no-supervisor')
  || 'WATCH_REPORT_DEPENDENCIES' in process.env;

if (direct) {
  await import('./src/main.ts');
} else {
  const { runSupervisor } = await import('./src/supervisor.ts');
  await runSupervisor(import.meta.filename);
}
