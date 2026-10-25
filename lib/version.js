import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

/** Package name, used for status keys, settings and log prefixes. */
export const PLUGIN_NAME = 'dsh-tui-cost-meter'

/** Version read from package.json so outbound requests never go stale. */
export const PLUGIN_VERSION = typeof pkg?.version === 'string' ? pkg.version : '0.0.0'

/** User-Agent for every outbound HTTP request. */
export const USER_AGENT = `${PLUGIN_NAME}/${PLUGIN_VERSION} (dsh-tui plugin)`
