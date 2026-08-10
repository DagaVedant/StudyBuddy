import { describe, expect, it, vi } from 'vitest'

import {
  confirmDestructive,
  databaseHost,
  isLocalDatabaseUrl,
  requireLocalDb,
} from '@/scripts/_confirm'

/**
 * Two consumers depend on the verdict below, which is why the false positives
 * matter more than the false negatives. `requireLocalDb` stops asking for
 * ALLOW_PROD=1, and `audit-worksheets.ts` picks `ssl: false`. A URL wrongly
 * called local therefore both unlocks a destructive script and sends the
 * password to that host in the clear.
 */
describe('isLocalDatabaseUrl', () => {
  it('accepts the connection strings a local checkout actually uses', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/db',
      'postgresql://u:p@127.0.0.1/db',
      'postgres://u:p@[::1]:5432/db',
    ]) {
      expect(isLocalDatabaseUrl(url), url).toBe(true)
    }
  })

  // 127.0.0.0/8 is loopback end to end, and the addresses in it that are not
  // 127.0.0.1 are ones a machine really binds: systemd-resolved answers on
  // 127.0.0.53, and a second alias is the usual way to run two Postgres
  // instances on the same port.
  it('accepts the whole 127.0.0.0/8 range, not just 127.0.0.1', () => {
    for (const url of [
      'postgres://u:p@127.0.0.2/db',
      'postgres://u:p@127.0.0.53:5432/db',
      'postgres://u:p@127.1.2.3/db',
    ]) {
      expect(isLocalDatabaseUrl(url), url).toBe(true)
    }
  })

  // libpq's socket form carries no authority at all. Calling "no host" remote
  // would make every destructive script demand ALLOW_PROD=1 on a machine with
  // no networked database configured, and getting used to typing ALLOW_PROD=1
  // is the precise habit this guard exists to prevent.
  it('accepts a unix socket, which has no host to be remote from', () => {
    expect(isLocalDatabaseUrl('postgres:///var/run/postgresql/db', {})).toBe(true)
    expect(
      isLocalDatabaseUrl('postgresql:///studybuddy?host=/var/run/postgresql', {}),
    ).toBe(true)
  })

  // `postgres:` is a non-special scheme, so the URL parser hands back the host
  // exactly as written instead of lowercasing it the way it would for http.
  // Only the explicit toLowerCase in the guard makes this one match.
  it('matches the hostname case-insensitively', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@LOCALHOST:5432/db')).toBe(true)
  })

  it('rejects a managed host', () => {
    expect(
      isLocalDatabaseUrl(
        'postgres://u:p@ep-quiet-frost-123.us-east-2.aws.neon.tech/db',
      ),
    ).toBe(false)
  })

  // The case the guard was rewritten for. The first spec tested the hostname
  // with /^localhost/, and `localhost.example.com` is a registrable domain
  // that somebody else can own, so the prefix rule handed a stranger's server
  // a local verdict and everything in this block's docstring followed.
  it('rejects a registrable domain that merely starts with localhost', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@localhost.example.com:5432/db')).toBe(
      false,
    )
  })

  // The same mistake one step looser: a substring test rather than a prefix
  // test still gets all of these wrong. Only the host decides, never the
  // database name and never the credentials, and note that the last one is a
  // real connection to evil.example.com because the parser splits userinfo on
  // the final `@`.
  it('rejects remote hosts with a loopback name somewhere else in the URL', () => {
    for (const url of [
      'postgres://u:p@my-localhost-db.example.com/db',
      'postgres://u:p@127.0.0.1.example.com/db',
      'postgres://u:p@db.example.com/localhost',
      'postgres://u:localhost@db.example.com/studybuddy',
      'postgres://u:p@localhost@evil.example.com/db',
    ]) {
      expect(isLocalDatabaseUrl(url), url).toBe(false)
    }
  })

  it('fails closed on anything it cannot parse', () => {
    for (const url of ['not a url', '', '://localhost/db', 'postgres://u:p@:5432/db']) {
      expect(isLocalDatabaseUrl(url), url).toBe(false)
    }
  })

  // A DATABASE_URL that lost its scheme parses as protocol `db.example.com:`
  // with an empty host, which is the same shape a unix socket has. postgres-js
  // would in fact connect to localhost for it, so nothing is reachable this
  // way, but the guard should not be the thing deciding that: an empty host
  // only counts as a socket when the scheme says the URL is a postgres URL.
  it('fails closed on a URL that is missing its scheme', () => {
    for (const url of ['db.example.com:5432/app', 'jdbc:postgresql://db.example.com/app']) {
      expect(isLocalDatabaseUrl(url), url).toBe(false)
    }
  })

  // The hole the socket branch left open. postgres-js resolves a URL with no
  // authority through $PGHOST before falling back to localhost, so with PGHOST
  // set to a managed host, `postgres:///studybuddy` is a Neon connection that
  // the guard was calling local: requireLocalDb passed, audit-worksheets chose
  // ssl: false from the same verdict, and AUDIT_FIX repaired a production
  // worksheet with no ALLOW_PROD anywhere.
  it('lets PGHOST decide when the URL carries no host', () => {
    const socket = 'postgres:///studybuddy'

    expect(isLocalDatabaseUrl(socket, {})).toBe(true)
    expect(isLocalDatabaseUrl(socket, { PGHOST: '/var/run/postgresql' })).toBe(true)
    expect(isLocalDatabaseUrl(socket, { PGHOST: 'localhost' })).toBe(true)
    expect(isLocalDatabaseUrl(socket, { PGHOST: '127.0.0.1' })).toBe(true)

    expect(
      isLocalDatabaseUrl(socket, { PGHOST: 'ep-quiet-frost-123.us-east-2.aws.neon.tech' }),
    ).toBe(false)
  })
})

describe('databaseHost', () => {
  // This string is printed to the terminal by confirmDestructive, and the URL
  // it comes from holds the password. Slicing the host off by hand (splitting
  // on `@`, for instance) is what puts credentials into a screenshot or a
  // pasted terminal log.
  it('never returns the password', () => {
    const url = 'postgres://studybuddy:hunter2-s3cret@db.internal.example.com:5432/app'

    expect(databaseHost(url)).toBe('db.internal.example.com:5432')
    expect(databaseHost(url)).not.toContain('hunter2')
    expect(databaseHost(url)).not.toContain('studybuddy')
  })

  // The port is the difference between two Postgres instances on one host, so
  // it is exactly what the operator needs to see in the confirmation prompt.
  it('keeps the port, which is often the only thing distinguishing two targets', () => {
    expect(databaseHost('postgres://u:p@localhost:5433/db')).toBe('localhost:5433')
    expect(databaseHost('postgres://u:p@localhost/db')).toBe('localhost')
  })

  // An empty host would print as an empty string, and a prompt reading
  // "About to repair X on ." tells the operator nothing.
  it('names the socket and the parse failure rather than printing nothing', () => {
    expect(databaseHost('postgres:///var/run/postgresql/db')).toBe('(unix socket)')
    expect(databaseHost('not a url')).toBe('(unparseable DATABASE_URL)')
  })
})

/**
 * Runs one assertion against a chosen environment and puts the previous values
 * back, restoring in a `finally` because a failed expectation throws. A leaked
 * ALLOW_PROD=1 would not fail anything: it would quietly satisfy every later
 * test in this file against a guard that had stopped guarding.
 */
function withEnv(
  env: { DATABASE_URL?: string; ALLOW_PROD?: string },
  body: () => void,
): void {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    ALLOW_PROD: process.env.ALLOW_PROD,
  }

  for (const key of ['DATABASE_URL', 'ALLOW_PROD'] as const) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }

  try {
    body()
  } finally {
    for (const key of ['DATABASE_URL', 'ALLOW_PROD'] as const) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

describe('requireLocalDb', () => {
  it('passes a local database through without ceremony', () => {
    withEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }, () => {
      expect(() => requireLocalDb()).not.toThrow()
    })
  })

  it('refuses a remote database and names the host it refused', () => {
    withEnv({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/app' }, () => {
      expect(() => requireLocalDb()).toThrow(/db\.example\.com:5432/)
    })
  })

  // The refusal is read off a terminal that may be shared or screenshotted, so
  // the message has to identify the target without quoting the URL back.
  it('keeps the password out of the refusal message', () => {
    withEnv({ DATABASE_URL: 'postgres://u:hunter2-s3cret@db.example.com/app' }, () => {
      expect(() => requireLocalDb()).toThrow(/db\.example\.com/)
      expect(() => requireLocalDb()).not.toThrow(/hunter2/)
    })
  })

  // ALLOW_PROD is a second thing to type on purpose. The failure it guards
  // against is running a command you have run a hundred times locally without
  // noticing which .env.local is loaded.
  it('lets ALLOW_PROD=1 through to a remote database', () => {
    withEnv(
      { DATABASE_URL: 'postgres://u:p@db.example.com/app', ALLOW_PROD: '1' },
      () => {
        expect(() => requireLocalDb()).not.toThrow()
      },
    )
  })

  // Exactly "1", not merely truthy. `ALLOW_PROD=true` and a stray `ALLOW_PROD=0`
  // both read as "I meant it" to a person skimming their shell history, and a
  // loose check would turn the second one into a live production write.
  it('does not accept a merely truthy ALLOW_PROD', () => {
    for (const value of ['true', 'yes', '0', 'false', '']) {
      withEnv(
        { DATABASE_URL: 'postgres://u:p@db.example.com/app', ALLOW_PROD: value },
        () => {
          expect(() => requireLocalDb(), value).toThrow(/not a local database/)
        },
      )
    }
  })

  // Unset is its own message rather than a refusal, because the operator who
  // hits this has not misaimed a script: they have not finished setting up.
  it('tells an unconfigured checkout what to do instead of refusing a host', () => {
    withEnv({ DATABASE_URL: undefined }, () => {
      expect(() => requireLocalDb()).toThrow(/\.env\.local/)
    })
  })
})

/**
 * The prompt itself, on the two paths that do not need a terminal.
 *
 * It is the last thing between an operator and six scripts that delete or
 * rewrite other people's rows, so the branch that skips it and the branch that
 * refuses to run without it are both worth pinning. The interactive path is
 * not tested: it blocks on stdin and there is nothing to assert that the two
 * branches here do not already cover.
 */
describe('confirmDestructive', () => {
  function withArgv<T>(argv: string[], body: () => T): T {
    const saved = process.argv
    process.argv = ['node', 'script.ts', ...argv]
    try {
      return body()
    } finally {
      process.argv = saved
    }
  }

  it('skips the prompt for --yes, and prints nothing', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line) => {
      lines.push(String(line))
    })

    try {
      await withArgv(['--yes'], () => confirmDestructive(['about to delete 40 rows']))
    } finally {
      log.mockRestore()
    }

    // Nothing printed, because nothing was asked. A summary printed and then
    // not acted on reads as a prompt that was answered.
    expect(lines).toEqual([])
  })

  // A destructive script reaching this in CI, or under a pipe, would otherwise
  // read EOF from stdin, take the empty answer as "not yes" and exit 1 anyway,
  // but only after printing a prompt nobody could see. Refusing up front says
  // what to do instead.
  it('refuses to run unattended without --yes', async () => {
    const isTty = process.stdin.isTTY
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line) => {
      printed.push(String(line))
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)

    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

      await expect(
        withArgv([], () => confirmDestructive(['about to delete 40 rows'])),
      ).rejects.toThrow('exited')

      expect(exit).toHaveBeenCalledWith(1)
      expect(printed.join('\n')).toContain('--yes')
    } finally {
      exit.mockRestore()
      log.mockRestore()
      Object.defineProperty(process.stdin, 'isTTY', { value: isTty, configurable: true })
    }
  })
})
