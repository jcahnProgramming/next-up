import { readFileSync } from 'node:fs';

/**
 * The app version: the newest entry of CHANGELOG.json (repo root; copied into the Docker image).
 * That file is the single place a release is recorded. It is validated at build time
 * (scripts/check-changelog.js), so here a problem is only logged, never fatal.
 */
function readRelease() {
  try {
    const doc = JSON.parse(readFileSync(new URL('../../CHANGELOG.json', import.meta.url), 'utf8'));
    const { version, date, title } = doc.releases[0];
    return { version, date, title };
  } catch (err) {
    console.error(`[version] couldn't read CHANGELOG.json: ${err.message}`);
    return { version: 'unknown', date: null, title: null };
  }
}

/** The newest release: { version, date, title }. */
export const APP_RELEASE = readRelease();
export const APP_VERSION = APP_RELEASE.version;
