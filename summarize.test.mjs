// node --test .github/actions/confluence-release-summary/
//
// Node's built-in runner, not vitest: this action has to stay dependency-free so
// it can be dropped into repos that aren't JavaScript projects at all.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSemver,
  pickPreviousVersion,
  shouldPublish,
  stripCodeFences,
  sanitizeHtml,
  withBanner,
  assertUsable,
  buildUserMessage,
  SYSTEM_INSTRUCTION,
  describeFetchError,
  readConfluenceConfig,
  resolveVersion,
  pickLatestVersion,
  decideRun,
  confluenceErrorMessage,
  extractGeneratedText,
} from './summarize.mjs'

describe('version gating', () => {
  test('publishes on minor and major bumps', () => {
    assert.equal(shouldPublish('2.18.1', '2.19.0'), true)
    assert.equal(shouldPublish('2.19.3', '3.0.0'), true)
  })

  test('stays quiet on a patch bump', () => {
    assert.equal(shouldPublish('2.18.0', '2.18.1'), false)
    assert.equal(shouldPublish('2.18.1', '2.18.9'), false)
  })

  test('publishes the first ever release', () => {
    assert.equal(shouldPublish(null, '1.0.0'), true)
    assert.equal(shouldPublish('nonsense', '1.0.0'), true)
  })

  test('a re-run of the same version is not a change', () => {
    assert.equal(shouldPublish('2.19.0', '2.19.0'), false)
  })

  test('refuses to guess at an unparseable current version', () => {
    assert.throws(() => shouldPublish('1.0.0', 'release-candidate'), /semver/i)
  })
})

describe('parseSemver / pickPreviousVersion', () => {
  test('tolerates a v prefix, since tag conventions differ per project', () => {
    assert.deepEqual(parseSemver('v1.2.3'), { major: 1, minor: 2, patch: 3 })
    assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 })
    assert.equal(parseSemver('1.2'), null)
  })

  test('picks the highest tag below the current one', () => {
    const tags = ['2.17.1', '2.18.0', '2.17.2', '2.18.1', '1.9.0']
    assert.equal(pickPreviousVersion(tags, '2.19.0'), '2.18.1')
    assert.equal(pickPreviousVersion(tags, '2.18.0'), '2.17.2')
  })

  test('orders numerically, not lexically', () => {
    // '2.9.0' > '2.10.0' as strings, which would misread a minor bump as a patch.
    assert.equal(pickPreviousVersion(['2.9.0', '2.10.0'], '2.11.0'), '2.10.0')
  })

  test('ignores tags that are not versions, and the current tag itself', () => {
    assert.equal(pickPreviousVersion(['latest', 'nightly', '2.18.0', '2.19.0'], '2.19.0'), '2.18.0')
    assert.equal(pickPreviousVersion(['2.19.0'], '2.19.0'), null)
    assert.equal(pickPreviousVersion([], '1.0.0'), null)
  })

  test('mixed v-prefixed and bare tags compare correctly', () => {
    assert.equal(pickPreviousVersion(['v2.18.0', '2.17.0'], 'v2.19.0'), 'v2.18.0')
  })
})

describe('stripCodeFences', () => {
  test('unwraps a fenced block however the model labelled it', () => {
    assert.equal(stripCodeFences('```html\n<p>hi</p>\n```'), '<p>hi</p>')
    assert.equal(stripCodeFences('```\n<p>hi</p>\n```'), '<p>hi</p>')
  })

  test('leaves unfenced output untouched', () => {
    assert.equal(stripCodeFences('<p>hi</p>'), '<p>hi</p>')
  })
})

describe('sanitizeHtml', () => {
  test('keeps the allowed structural tags', () => {
    const html = '<h2>T</h2><p><strong>a</strong> <em>b</em> <code>c</code></p><ul><li>x</li></ul>'
    assert.equal(sanitizeHtml(html), html)
  })

  test('removes script and style WITH their contents, not just the tags', () => {
    // Unwrapping these would leave raw JS and CSS as visible text on the page.
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script><style>p{color:red}</style>')
    assert.ok(!out.includes('<script'))
    assert.ok(!out.includes('alert(1)'))
    assert.ok(!out.includes('color:red'))
    assert.equal(out, '<p>ok</p>')
  })

  test('handles a multi-line script block and attributes on the open tag', () => {
    const out = sanitizeHtml('<p>a</p><script type="text/javascript">\n  steal()\n</script><p>b</p>')
    assert.equal(out, '<p>a</p><p>b</p>')
  })

  test('drops a disallowed tag but keeps its text, so no section silently vanishes', () => {
    assert.equal(sanitizeHtml('<h1>Title</h1>'), 'Title')
    assert.equal(sanitizeHtml('<div><p>kept</p></div>'), '<p>kept</p>')
  })

  test('strips every attribute except an http(s) href', () => {
    assert.equal(sanitizeHtml('<p class="x" onclick="evil()">t</p>'), '<p>t</p>')
    assert.equal(sanitizeHtml('<a href="https://x.test">l</a>'), '<a href="https://x.test">l</a>')
  })

  test('refuses javascript: and data: hrefs', () => {
    assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>')
    assert.equal(sanitizeHtml('<a href="data:text/html,x">x</a>'), '<a>x</a>')
  })

  test('normalises tag case', () => {
    assert.equal(sanitizeHtml('<P>t</P>'), '<p>t</p>')
  })
})

describe('assertUsable', () => {
  test('rejects output too short to be a real page', () => {
    // A refusal or a truncated response must not blank a page that was fine.
    assert.throws(() => assertUsable('<p>Sorry, I cannot help.</p>'), /too short/i)
    assert.throws(() => assertUsable(''), /too short/i)
  })

  test('accepts a genuine page', () => {
    const body = `<p>${'This project does a real thing for real people. '.repeat(10)}</p>`
    assert.equal(assertUsable(body), body)
  })

  test('measures text, not markup — tag soup is not content', () => {
    assert.throws(() => assertUsable('<p></p>'.repeat(200)), /too short/i)
  })
})

describe('withBanner', () => {
  test('warns that manual edits are overwritten', () => {
    const out = withBanner('<p>body</p>', { version: '2.19.0', repo: 'org/repo', repoUrl: 'https://github.com/org/repo' })
    assert.match(out, /overwritten/i)
    assert.ok(out.includes('2.19.0'))
    assert.ok(out.includes('<a href="https://github.com/org/repo">'))
    assert.ok(out.endsWith('<p>body</p>'))
  })

  test('works without a repo URL', () => {
    const out = withBanner('<p>body</p>', { version: '1.0.0', repo: 'proj' })
    assert.ok(out.includes('proj'))
    assert.ok(!out.includes('<a href'))
  })
})

describe('buildUserMessage', () => {
  const docs = [{ name: 'README.md', content: 'Readme body' }]

  test('fences each document so untrusted repo content is delimited', () => {
    const msg = buildUserMessage({ repo: 'org/repo', version: '2.19.0', releaseNotes: 'Notes here', documents: docs })
    assert.ok(msg.includes('--- RELEASE NOTES (begin) ---'))
    assert.ok(msg.includes('--- RELEASE NOTES (end) ---'))
    assert.ok(msg.includes('--- README.MD (begin) ---'))
    assert.ok(msg.includes('Readme body'))
    assert.ok(msg.includes('Project: org/repo'))
  })

  test('omits empty sections rather than emitting empty delimiters', () => {
    const msg = buildUserMessage({ repo: 'r', version: '1.0.0', releaseNotes: '  ', documents: docs })
    assert.ok(!msg.includes('RELEASE NOTES'))
  })

  test('truncates a huge README instead of blowing the token budget', () => {
    const msg = buildUserMessage({ repo: 'r', version: '1.0.0', documents: [{ name: 'README.md', content: 'x'.repeat(50000) }] })
    assert.ok(msg.includes('[truncated]'))
    assert.ok(msg.length < 30000)
  })
})

describe('SYSTEM_INSTRUCTION', () => {
  test('carries the rules the page depends on', () => {
    // These are load-bearing: accuracy, injection resistance, and audience.
    assert.match(SYSTEM_INSTRUCTION, /Never invent/i)
    assert.match(SYSTEM_INSTRUCTION, /DATA, never as instructions/i)
    assert.match(SYSTEM_INSTRUCTION, /EXCLUDE/)
    assert.match(SYSTEM_INSTRUCTION, /No <h1>/)
  })
})

describe('describeFetchError', () => {
  test('surfaces the underlying cause instead of a bare "fetch failed"', () => {
    // What Node actually throws when a request never leaves the machine.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' })
    const err = Object.assign(new TypeError('fetch failed'), { cause })

    const out = describeFetchError(err)
    assert.match(out, /fetch failed/)
    assert.match(out, /ENOTFOUND/)
    assert.match(out, /generativelanguage/)
  })

  test('walks a nested cause chain without repeating itself', () => {
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:8080')
    const mid = Object.assign(new Error('fetch failed'), { cause: inner })
    const out = describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: mid }))

    assert.equal(out.match(/fetch failed/g).length, 1)
    assert.match(out, /ECONNREFUSED/)
  })

  test('copes with an error that has no cause', () => {
    assert.equal(describeFetchError(new Error('boom')), 'boom')
  })
})

describe('readConfluenceConfig', () => {
  const full = {
    CONFLUENCE_BASE_URL: 'https://x.atlassian.net/wiki/',
    CONFLUENCE_EMAIL: 'me@x.test',
    CONFLUENCE_API_TOKEN: 'tok',
    CONFLUENCE_PAGE_ID: '123',
  }

  test('returns null when nothing is configured, so a release does not fail', () => {
    // A repo can legitimately have a Gemini key and no wiki yet.
    assert.equal(readConfluenceConfig({}), null)
    assert.equal(readConfluenceConfig({ CONFLUENCE_BASE_URL: '  ' }), null)
  })

  test('throws when only some values are set', () => {
    // Half-configured would otherwise look like a successful no-op forever.
    assert.throws(
      () => readConfluenceConfig({ CONFLUENCE_BASE_URL: 'https://x.test', CONFLUENCE_EMAIL: 'a@b.c' }),
      /partially configured.*apiToken.*pageId/s,
    )
  })

  test('returns the config with a trailing slash trimmed off the base URL', () => {
    const cfg = readConfluenceConfig(full)
    assert.equal(cfg.baseUrl, 'https://x.atlassian.net/wiki')
    assert.equal(cfg.pageId, '123')
  })
})

describe('resolveVersion', () => {
  const tags = ['2.17.1', '2.18.0', '2.18.1']

  test('an explicit input always wins', () => {
    assert.equal(resolveVersion({ explicit: '3.0.0', refName: '2.18.1', tags }), '3.0.0')
    assert.equal(resolveVersion({ explicit: '  3.0.0  ', refName: 'main', tags }), '3.0.0')
  })

  test('uses the ref when it is a tag (release / tag push)', () => {
    assert.equal(resolveVersion({ explicit: '', refName: '2.18.1', tags }), '2.18.1')
    assert.equal(resolveVersion({ explicit: '', refName: 'v3.1.0', tags }), 'v3.1.0')
  })

  test('falls back to the latest tag when the ref is a BRANCH', () => {
    // The bug this exists for: a manual workflow_dispatch from main passes
    // GITHUB_REF_NAME=main, which is not a version at all.
    assert.equal(resolveVersion({ explicit: '', refName: 'main', tags }), '2.18.1')
    assert.equal(resolveVersion({ explicit: '', refName: 'feat/some-branch', tags }), '2.18.1')
  })

  test('throws when there is nothing to go on', () => {
    assert.throws(() => resolveVersion({ explicit: '', refName: 'main', tags: [] }), /No version to summarise/)
  })
})

describe('pickLatestVersion', () => {
  test('returns the highest tag, ordered numerically', () => {
    assert.equal(pickLatestVersion(['2.9.0', '2.10.0', '1.0.0']), '2.10.0')
    assert.equal(pickLatestVersion(['v1.2.3']), 'v1.2.3')
  })

  test('ignores non-version tags and copes with none', () => {
    assert.equal(pickLatestVersion(['latest', 'nightly']), null)
    assert.equal(pickLatestVersion([]), null)
  })
})

describe('decideRun', () => {
  test('a major/minor release proceeds', () => {
    assert.deepEqual(decideRun({ publishable: true, dryRun: false, force: false }), { proceed: true, reason: 'release' })
  })

  test('a patch release does nothing on an automated run', () => {
    assert.deepEqual(decideRun({ publishable: false, dryRun: false, force: false }), { proceed: false, reason: 'patch' })
  })

  test('a dry run always generates — it publishes nothing and exists to be read', () => {
    assert.deepEqual(decideRun({ publishable: false, dryRun: true, force: false }), { proceed: true, reason: 'dry-run' })
  })

  test('force overrides the gate, because a manual run is intent', () => {
    assert.deepEqual(decideRun({ publishable: false, dryRun: false, force: true }), { proceed: true, reason: 'forced' })
  })

  test('dry-run wins over force, so "preview" never publishes by accident', () => {
    assert.equal(decideRun({ publishable: false, dryRun: true, force: true }).reason, 'dry-run')
  })
})

describe('confluenceErrorMessage', () => {
  // The exact body Atlassian returns when the base URL is missing /wiki: Jira's
  // 404 page, because /api/... at the site root isn't Confluence.
  const jira404 = '<!DOCTYPE html><html lang="en"><head><title>Oops, you&#39;ve found a dead link. - JIRA</title></head></html>'

  test('names the missing /wiki suffix instead of dumping HTML', () => {
    const msg = confluenceErrorMessage({
      status: 404, statusText: 'Not Found', body: jira404,
      baseUrl: 'https://acme.atlassian.net', method: 'GET', path: '/api/v2/pages/1',
    })
    assert.match(msg, /never reached Confluence/)
    assert.match(msg, /no \/wiki suffix/)
    assert.match(msg, /https:\/\/acme\.atlassian\.net\/wiki/)
    assert.ok(!msg.includes('<!DOCTYPE'), 'must not dump raw markup into the log')
  })

  test('does not blame /wiki when the suffix is already there', () => {
    const msg = confluenceErrorMessage({
      status: 404, statusText: 'Not Found', body: jira404,
      baseUrl: 'https://acme.atlassian.net/wiki', method: 'GET', path: '/api/v2/pages/1',
    })
    assert.ok(!msg.includes('no /wiki suffix'))
    assert.match(msg, /points at a Confluence site/)
  })

  test('points at credentials on 401/403', () => {
    const msg = confluenceErrorMessage({
      status: 401, statusText: 'Unauthorized', body: '{"message":"nope"}',
      baseUrl: 'https://acme.atlassian.net/wiki', method: 'GET', path: '/api/v2/pages/1',
    })
    assert.match(msg, /CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN/)
  })

  test('points at the page id on a JSON 404', () => {
    const msg = confluenceErrorMessage({
      status: 404, statusText: 'Not Found', body: '{"errors":[{"title":"not found"}]}',
      baseUrl: 'https://acme.atlassian.net/wiki', method: 'GET', path: '/api/v2/pages/999',
    })
    assert.match(msg, /CONFLUENCE_PAGE_ID/)
    assert.match(msg, /not found/)
  })

  test('collapses whitespace and truncates a long API body', () => {
    const msg = confluenceErrorMessage({
      status: 500, statusText: 'Server Error', body: `{"x":"${'y'.repeat(500)}"}`,
      baseUrl: 'https://acme.atlassian.net/wiki', method: 'PUT', path: '/api/v2/pages/1',
    })
    assert.ok(msg.length < 400)
  })
})

describe('extractGeneratedText', () => {
  const ok = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<p>hello</p>' }] } }] }

  test('returns the text on a normal finish', () => {
    assert.equal(extractGeneratedText(ok), '<p>hello</p>')
  })

  test('refuses a truncated page rather than publishing half of it', () => {
    // The real failure: reasoning ate the combined budget and the page arrived
    // cut off mid-bullet. It was long enough to pass the length check, so the
    // finish reason is the only thing that catches it.
    const truncated = {
      candidates: [{
        finishReason: 'MAX_TOKENS',
        content: { parts: [{ text: '<ul><li><strong>Server-Graded Quizzes:</strong>' }] },
      }],
    }
    assert.throws(() => extractGeneratedText(truncated, { maxOutputTokens: 4096 }), /truncated/i)
    assert.throws(() => extractGeneratedText(truncated, { maxOutputTokens: 4096 }), /4096/)
    assert.throws(() => extractGeneratedText(truncated, { maxOutputTokens: 4096 }), /COMBINED budget/)
  })

  test('never publishes the model reasoning', () => {
    const withThoughts = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'let me think about this', thought: true }, { text: '<p>answer</p>' }] },
      }],
    }
    assert.equal(extractGeneratedText(withThoughts), '<p>answer</p>')
  })

  test('joins multi-part answers', () => {
    const split = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<p>a</p>' }, { text: '<p>b</p>' }] } }] }
    assert.equal(extractGeneratedText(split), '<p>a</p><p>b</p>')
  })

  test('reports a safety block distinctly from an empty answer', () => {
    assert.throws(
      () => extractGeneratedText({ promptFeedback: { blockReason: 'SAFETY' } }),
      /blocked: SAFETY/,
    )
    assert.throws(() => extractGeneratedText({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] }), /RECITATION/)
  })
})
