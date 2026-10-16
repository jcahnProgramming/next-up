import changelog from '../../CHANGELOG.json';

/**
 * The app version and release notes, from CHANGELOG.json at the repo root: the single place a
 * release is recorded. The newest entry is the version. Baked in at build time.
 */
export const RELEASES = changelog.releases;
export const APP_VERSION = RELEASES[0].version;
