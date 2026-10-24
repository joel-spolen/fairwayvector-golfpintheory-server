import { loadConfig, ConfigurationError } from './config.js';
import { buildApp } from './app.js';

try {
  const config = loadConfig();
  // Disable automatic HTTP logs: URLs can contain search terms or location data.
  const app = await buildApp(config);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
    });
  }
  try {
    await app.listen({ host: config.host, port: config.port });
    const host = config.host === '::1' ? '[::1]' : config.host;
    console.info(`PinTheory local admin GUI: http://${host}:${app.server.address().port}/admin`);
  } catch {
    await app.close();
    console.error('Server could not listen. Check the configured host and port.');
    process.exitCode = 1;
  }
} catch (error) {
  // ConfigurationError contains only our fixed messages, never actual values.
  // Keep arbitrary filesystem/database errors redacted.
  console.error(error instanceof ConfigurationError
    ? `Server configuration error: ${error.message}. Update the local environment configuration and restart.`
    : 'Local admin startup failed. Check configuration and Node version.');
  process.exitCode = 1;
}