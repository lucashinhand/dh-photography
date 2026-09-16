/** Shared static deployment settings; never hard-code the project prefix in content. */
const configuredBase =
  process.env.SITE_BASE || process.env.PUBLIC_BASE_PATH || '/dh-photography/';
export const siteBase =
  configuredBase === '/'
    ? '/'
    : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;
export const siteOrigin = (
  process.env.SITE_ORIGIN ||
  process.env.PUBLIC_SITE_ORIGIN ||
  'https://lucashahn.dev'
).replace(/\/$/, '');
