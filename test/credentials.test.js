import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CODEX_OAUTH_PROVIDER,
  credentialPaths,
  decodeTokenClaims,
  readBestCredential,
  readCredentialCandidates,
} from '../lib/credentials.js'

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

function claimsToken(accountId, expiresInSeconds = 3600) {
  return jwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })
}

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), 'codex-quota-test-'))
  const dshHome = join(root, 'dsh')
  const codexHome = join(root, 'codex')
  await mkdir(dshHome, { recursive: true })
  await mkdir(codexHome, { recursive: true })
  return { root, dshHome, codexHome, env: { DSH_HOME: dshHome, CODEX_HOME: codexHome } }
}

async function writeDshAuth(dshHome, provider) {
  await mkdir(join(dshHome, 'dsh-auth'), { recursive: true })
  await writeFile(
    join(dshHome, 'dsh-auth', 'credentials.json'),
    JSON.stringify({ version: 1, providers: { [CODEX_OAUTH_PROVIDER]: provider } }),
  )
}

async function writeDshCodex(dshHome, credential) {
  await writeFile(
    join(dshHome, '.openai-codex-auth.json'),
    JSON.stringify({ version: 1, credential }),
  )
}

async function writeNative(codexHome, document) {
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify(document))
}

test('resolves the three credential documents', () => {
  const paths = credentialPaths({ DSH_HOME: '/dsh', CODEX_HOME: '/codex' })
  assert.equal(paths.dshAuth, '/dsh/dsh-auth/credentials.json')
  assert.equal(paths.dshCodex, '/dsh/.openai-codex-auth.json')
  assert.equal(paths.nativeCodex, '/codex/auth.json')
})

test('reads dsh-auth OAuth credentials', async () => {
  const { root, dshHome, env } = await makeHome()
  try {
    await writeDshAuth(dshHome, {
      type: 'oauth',
      access: claimsToken('account-from-claims'),
      accountId: 'account-from-field',
      expires: Date.now() + 3_600_000,
    })
    const candidate = await readBestCredential(env)
    assert.equal(candidate?.source, 'dsh-auth')
    assert.equal(candidate?.accountId, 'account-from-field')
    assert.equal(candidate?.expired, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fills the account id from JWT claims when the document omits it', async () => {
  const { root, dshHome, env } = await makeHome()
  try {
    await writeDshAuth(dshHome, {
      type: 'oauth',
      access: claimsToken('claims-account'),
      expires: Date.now() + 3_600_000,
    })
    assert.equal((await readBestCredential(env))?.accountId, 'claims-account')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reads the dsh-codex credential document', async () => {
  const { root, dshHome, env } = await makeHome()
  try {
    await writeDshCodex(dshHome, {
      type: 'oauth',
      access: claimsToken('codex-account'),
      refresh: 'refresh-token',
      accountId: 'codex-account',
      expires: Date.now() + 3_600_000,
    })
    const candidate = await readBestCredential(env)
    assert.equal(candidate?.source, 'dsh-codex')
    assert.equal(candidate?.accountId, 'codex-account')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reads native Codex CLI tokens and ignores API-key files', async () => {
  const { root, codexHome, env } = await makeHome()
  try {
    await writeNative(codexHome, {
      tokens: {
        access_token: claimsToken('native-account'),
        account_id: 'native-account',
      },
    })
    assert.equal((await readBestCredential(env))?.source, 'codex-cli')

    await writeNative(codexHome, { OPENAI_API_KEY: 'sk-test' })
    assert.equal(await readBestCredential(env), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prefers a live token over an expired one', async () => {
  const { root, dshHome, env } = await makeHome()
  try {
    await writeDshAuth(dshHome, {
      type: 'oauth',
      access: claimsToken('expired-account', -3600),
      accountId: 'expired-account',
      expires: Date.now() - 3_600_000,
    })
    await writeDshCodex(dshHome, {
      type: 'oauth',
      access: claimsToken('live-account'),
      accountId: 'live-account',
      expires: Date.now() + 3_600_000,
    })
    const candidates = await readCredentialCandidates(env)
    assert.equal(candidates.length, 2)
    assert.equal(candidates[0].accountId, 'live-account')
    assert.equal((await readBestCredential(env))?.accountId, 'live-account')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('returns the newest expired token so the UI can say "login expired"', async () => {
  const { root, dshHome, env } = await makeHome()
  try {
    await writeDshAuth(dshHome, {
      type: 'oauth',
      access: claimsToken('old', -7200),
      accountId: 'old',
      expires: Date.now() - 7_200_000,
    })
    await writeDshCodex(dshHome, {
      type: 'oauth',
      access: claimsToken('newer', -3600),
      accountId: 'newer',
      expires: Date.now() - 3_600_000,
    })
    const candidate = await readBestCredential(env)
    assert.equal(candidate?.accountId, 'newer')
    assert.equal(candidate?.expired, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('decodes only complete JWT payloads', () => {
  assert.equal(decodeTokenClaims('not-a-jwt'), undefined)
  assert.equal(decodeTokenClaims('a.b'), undefined)
  const decoded = decodeTokenClaims(claimsToken('abc', 60))
  assert.equal(decoded?.accountId, 'abc')
  assert.ok((decoded?.expiresAt ?? 0) > Date.now())
})
