import { describe, expect, it, vi } from 'vitest'

import {
  confirmDestructive,
  databaseHost,
  isLocalDatabaseUrl,
  requireLocalDb,
} from '@/scripts/_confirm'

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

  it('accepts the whole 127.0.0.0/8 range, not just 127.0.0.1', () => {
    for (const url of [
      'postgres://u:p@127.0.0.2/db',
      'postgres://u:p@127.0.0.53:5432/db',
      'postgres://u:p@127.1.2.3/db',
    ]) {
      expect(isLocalDatabaseUrl(url), url).toBe(true)
    }
  })

  it('accepts a unix socket, which has no host to be remote from', () => {
    expect(isLocalDatabaseUrl('postgres:///var/run/postgresql/db', {})).toBe(true)
    expect(
      isLocalDatabaseUrl('postgresql:///studybuddy?host=/var/run/postgresql', {}),
    ).toBe(true)
  })

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

  it('rejects a registrable domain that merely starts with localhost', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@localhost.example.com:5432/db')).toBe(
      false,
    )
  })

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

  it('fails closed on a URL that is missing its scheme', () => {
    for (const url of ['db.example.com:5432/app', 'jdbc:postgresql://db.example.com/app']) {
      expect(isLocalDatabaseUrl(url), url).toBe(false)
    }
  })

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
  it('never returns the password', () => {
    const url = 'postgres://studybuddy:hunter2-s3cret@db.internal.example.com:5432/app'

    expect(databaseHost(url)).toBe('db.internal.example.com:5432')
    expect(databaseHost(url)).not.toContain('hunter2')
    expect(databaseHost(url)).not.toContain('studybuddy')
  })

  it('keeps the port, which is often the only thing distinguishing two targets', () => {
    expect(databaseHost('postgres://u:p@localhost:5433/db')).toBe('localhost:5433')
    expect(databaseHost('postgres://u:p@localhost/db')).toBe('localhost')
  })

  it('names the socket and the parse failure rather than printing nothing', () => {
    expect(databaseHost('postgres:///var/run/postgresql/db')).toBe('(unix socket)')
    expect(databaseHost('not a url')).toBe('(unparseable DATABASE_URL)')
  })
})

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

  it('keeps the password out of the refusal message', () => {
    withEnv({ DATABASE_URL: 'postgres://u:hunter2-s3cret@db.example.com/app' }, () => {
      expect(() => requireLocalDb()).toThrow(/db\.example\.com/)
      expect(() => requireLocalDb()).not.toThrow(/hunter2/)
    })
  })

  it('lets ALLOW_PROD=1 through to a remote database', () => {
    withEnv(
      { DATABASE_URL: 'postgres://u:p@db.example.com/app', ALLOW_PROD: '1' },
      () => {
        expect(() => requireLocalDb()).not.toThrow()
      },
    )
  })

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

  it('tells an unconfigured checkout what to do instead of refusing a host', () => {
    withEnv({ DATABASE_URL: undefined }, () => {
      expect(() => requireLocalDb()).toThrow(/\.env\.local/)
    })
  })
})

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

    expect(lines).toEqual([])
  })

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
