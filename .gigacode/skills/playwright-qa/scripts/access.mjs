import path from 'node:path';
import { readJSON, loadEnvironment, BlockedError } from './core.mjs';

export function tlsPolicy(baseURL) {
  return {ignoreHTTPSErrors:true, origin:new URL(baseURL).origin, scope:'all-sites'};
}

export async function createContext(browser, profile) {
  const policy = profile.tlsPolicy ?? tlsPolicy(profile.values.baseURL);
  return browser.newContext({
    baseURL: profile.values.baseURL,
    ignoreHTTPSErrors: policy.ignoreHTTPSErrors
  });
}

export function resolveSource(root, name, target, env = loadEnvironment(root)) {
  const config = readJSON(path.join(root,'config/sources.json'))[name];
  if (!config || !['password','anonymous'].includes(config.auth)) throw new BlockedError('Unknown source or unsupported auth: ' + name);
  const values = {}, missing = [];
  for (const [key, binding] of Object.entries(config.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) throw new BlockedError('Invalid source binding');
    if (env[binding] === undefined || env[binding] === '') missing.push(binding);
    else values[key] = env[binding];
  }
  if (missing.length) throw new BlockedError('Missing source env: ' + missing.join(', '));
  if (!values.baseURL || (config.auth==='password' && (!values.login || !values.password))) throw new BlockedError('Incomplete source profile');
  let base, url;
  try { base = new URL(values.baseURL); url = new URL(target, base); } catch { throw new BlockedError('Invalid source URL'); }
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || url.username || url.password || url.origin !== base.origin) {
    throw new BlockedError('Source URL must match configured origin without embedded credentials');
  }
  return { ...config, name, values, target:url.href, secrets:[values.login,values.password].filter(Boolean),
    tlsPolicy:tlsPolicy(values.baseURL) };
}

export async function openSource(browser, profile, authenticate) {
  const context = await createContext(browser,profile);
  try {
    const page = await context.newPage();
    await page.goto(profile.target);
    if (profile.auth==='password') {
      if (typeof authenticate !== 'function') throw new BlockedError('Source requires a site-specific login callback');
      // Never expose source credentials to an unexpected redirected origin.
      if (new URL(page.url()).origin !== new URL(profile.values.baseURL).origin) {
        throw new BlockedError('Source redirected to another origin; configure explicit SSO adapter');
      }
      await authenticate({page,login:profile.values.login,password:profile.values.password});
      await page.goto(profile.target);
    }
    return {context,page}; // Caller reads content, masks secrets, then closes context.
  } catch (error) { await context.close(); throw error; }
}
