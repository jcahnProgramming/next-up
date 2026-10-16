import { APP_RELEASE } from '../../core/version.js';

/** get_version: what is running, straight from CHANGELOG.json. */
export default {
  name: 'get_version',
  title: 'Get Next Up version',
  description:
    'The version of Next Up that is running, with the date and title of that release, from its changelog. ' +
    'Takes no arguments.',
  input: {},
  resolve: () => ({ app: 'Next Up', ...APP_RELEASE }),
};
