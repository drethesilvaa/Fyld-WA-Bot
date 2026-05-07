'use strict';

// ─── Mock factories ───────────────────────────────────────────────────────────

function makeMockSock() {
  const listeners = {};
  return {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
    ev: {
      on: jest.fn((event, cb) => { listeners[event] = cb; }),
    },
    // Fire a registered event handler
    _fire: async (event, payload) => {
      if (listeners[event]) await listeners[event](payload);
    },
  };
}

function makeDbMock(resolveWith = []) {
  const mockOrderBy  = jest.fn().mockResolvedValue(resolveWith);
  const mockSelect   = jest.fn(() => ({ orderBy: mockOrderBy }));
  const mockWhereRaw = jest.fn(() => ({ select: mockSelect }));
  const mockDb       = jest.fn(() => ({ whereRaw: mockWhereRaw }));
  return { mockDb, mockWhereRaw, mockSelect, mockOrderBy };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('birthdayBot', () => {
  let mockSock;
  let mockCronJob;
  let mockSchedule;
  let mockGenerate;
  let mockSaveCreds;
  let mockDb, mockWhereRaw, mockOrderBy;
  let birthdayBot;
  let makeWASocketMock;

  // Default group set (Fyld present)
  const FYLD_GROUP = { g1: { id: 'group-fyld-001', subject: 'Fyld' } };

  // Shared person fixtures
  const alice = { first_name: 'Alice', last_name: 'Smith',  phone_number: '+44 7700 900123' };
  const bob   = { first_name: 'Bob',   last_name: 'Jones',  phone_number: '07700-900-456'   };

  beforeEach(() => {
    jest.resetModules();

    mockSock     = makeMockSock();
    mockCronJob  = { stop: jest.fn() };
    mockSchedule = jest.fn().mockReturnValue(mockCronJob);
    mockGenerate = jest.fn();
    mockSaveCreds = jest.fn();
    ({ mockDb, mockWhereRaw, mockOrderBy } = makeDbMock());

    makeWASocketMock = jest.fn(() => mockSock);

    jest.doMock('@whiskeysockets/baileys', () => ({
      default: makeWASocketMock,
      useMultiFileAuthState: jest.fn().mockResolvedValue({ state: {}, saveCreds: mockSaveCreds }),
      DisconnectReason: { loggedOut: 401 },
    }));
    jest.doMock('qrcode-terminal', () => ({ generate: mockGenerate }));
    jest.doMock('node-cron',       () => ({ schedule: mockSchedule }));
    jest.doMock('pino',            () => jest.fn(() => ({})));
    jest.doMock('../src/models/database', () => mockDb);

    birthdayBot = require('../src/services/birthdayBot');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Helper: init bot and fire 'connection.update' open event
  async function connectAndOpen(groups = FYLD_GROUP, dbRows = []) {
    mockSock.groupFetchAllParticipating.mockResolvedValue(groups);
    mockOrderBy.mockResolvedValue(dbRows);
    await birthdayBot.initBirthdayBot();
    await mockSock._fire('connection.update', { connection: 'open' });
    await Promise.resolve();
  }

  // ── phoneToJid (tested via mentions in sendMessage) ──────────────────────

  describe('phoneToJid', () => {
    const cases = [
      ['+44 7700 900123',   '447700900123@s.whatsapp.net'],
      ['07700-900-456',     '07700900456@s.whatsapp.net'],
      ['447700900123',      '447700900123@s.whatsapp.net'],
      ['+1 (555) 123-4567', '15551234567@s.whatsapp.net'],
    ];

    test.each(cases)('converts "%s" → "%s"', async (phone, expectedJid) => {
      await connectAndOpen(FYLD_GROUP, [{ first_name: 'A', last_name: 'B', phone_number: phone }]);
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(msg.mentions[0]).toBe(expectedJid);
    });
  });

  // ── buildMessage ──────────────────────────────────────────────────────────

  describe('buildMessage', () => {
    beforeEach(async () => {
      await connectAndOpen(FYLD_GROUP, [alice]);
    });

    test('text starts with 🎂 and @mentions the person', () => {
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(msg.text).toMatch(/🎂 Happy birthday @Alice Smith!/);
    });

    test('text contains the closing wish', () => {
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(msg.text).toContain('Wishing you a fantastic day filled with joy');
    });

    test('mentions array has exactly one entry', () => {
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(msg.mentions).toHaveLength(1);
    });

    test('emoji in text is from the EMOJIS list', () => {
      const EMOJIS = ['🎈', '🎊', '🎁', '🌟', '✨', '💫'];
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(EMOJIS.some((e) => msg.text.includes(e))).toBe(true);
    });

    test('Math.random=0 produces first emoji 🎈', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      mockSock.sendMessage.mockClear();
      mockOrderBy.mockResolvedValue([alice]);
      await birthdayBot.checkAndSendBirthdays();
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(msg.text).toContain('🎈');
    });
  });

  // ── getTodaysBirthdays ────────────────────────────────────────────────────

  describe('getTodaysBirthdays', () => {
    beforeEach(async () => {
      await connectAndOpen(FYLD_GROUP, []);
      mockDb.mockClear();
      mockWhereRaw.mockClear();
      mockOrderBy.mockClear();
    });

    test('queries the contacts table', async () => {
      mockOrderBy.mockResolvedValue([]);
      await birthdayBot.checkAndSendBirthdays();
      expect(mockDb).toHaveBeenCalledWith('contacts');
    });

    test('whereRaw contains EXTRACT(MONTH and EXTRACT(DAY filters', async () => {
      mockOrderBy.mockResolvedValue([]);
      await birthdayBot.checkAndSendBirthdays();
      const sql = mockWhereRaw.mock.calls[0][0];
      expect(sql).toMatch(/EXTRACT\(MONTH/);
      expect(sql).toMatch(/EXTRACT\(DAY/);
    });

    test('selects phone_number (verified via mentions in sendMessage)', async () => {
      // phone_number inclusion is verified indirectly: buildMessage uses it for mentions,
      // so if sendMessage receives a JID the column must have been selected.
      mockOrderBy.mockResolvedValue([alice]);
      jest.useFakeTimers();
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      jest.useRealTimers();
      const [, msg] = mockSock.sendMessage.mock.calls[0];
      expect(msg.mentions[0]).toMatch(/@s\.whatsapp\.net$/);
    });

    test('orders by first_name', async () => {
      mockOrderBy.mockResolvedValue([]);
      await birthdayBot.checkAndSendBirthdays();
      // orderBy is the last in the chain: db().whereRaw().select().orderBy()
      expect(mockOrderBy).toHaveBeenCalledWith('first_name');
    });
  });

  // ── checkAndSendBirthdays ─────────────────────────────────────────────────

  describe('checkAndSendBirthdays', () => {
    let logSpy, errSpy;

    beforeEach(async () => {
      await connectAndOpen(FYLD_GROUP, []);
      mockSock.sendMessage.mockClear();
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    test('logs "No birthdays today" when result is empty', async () => {
      mockOrderBy.mockResolvedValue([]);
      await birthdayBot.checkAndSendBirthdays();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/No birthdays today/i));
    });

    test('sendMessage never called when no birthdays', async () => {
      mockOrderBy.mockResolvedValue([]);
      await birthdayBot.checkAndSendBirthdays();
      expect(mockSock.sendMessage).not.toHaveBeenCalled();
    });

    test('sends exactly one message for one birthday', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice]);
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    test('sends two messages for two birthdays', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice, bob]);
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      expect(mockSock.sendMessage).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    test('messages sent in DB order (Alice before Bob)', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice, bob]);
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      expect(mockSock.sendMessage.mock.calls[0][1].text).toMatch(/Alice/);
      expect(mockSock.sendMessage.mock.calls[1][1].text).toMatch(/Bob/);
      jest.useRealTimers();
    });

    test('sendMessage called with correct groupId', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice]);
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      expect(mockSock.sendMessage.mock.calls[0][0]).toBe('group-fyld-001');
      jest.useRealTimers();
    });

    test('DB error — resolves without throwing', async () => {
      mockOrderBy.mockRejectedValue(new Error('DB down'));
      await expect(birthdayBot.checkAndSendBirthdays()).resolves.toBeUndefined();
    });

    test('DB error — logs the error message', async () => {
      mockOrderBy.mockRejectedValue(new Error('DB down'));
      await birthdayBot.checkAndSendBirthdays();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error checking birthdays'),
        'DB down'
      );
    });

    test('sendMessage throws — resolves without propagating', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice]);
      mockSock.sendMessage.mockRejectedValue(new Error('WA send fail'));
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await expect(p).resolves.toBeUndefined();
      jest.useRealTimers();
    });

    test('sendMessage throws — logs error with person name', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice]);
      mockSock.sendMessage.mockRejectedValue(new Error('WA send fail'));
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Alice Smith'),
        'WA send fail'
      );
      jest.useRealTimers();
    });

    test('logs count when birthdays found', async () => {
      jest.useFakeTimers();
      mockOrderBy.mockResolvedValue([alice, bob]);
      const p = birthdayBot.checkAndSendBirthdays();
      await jest.runAllTimersAsync();
      await p;
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/2 birthday/i));
      jest.useRealTimers();
    });
  });

  // ── findGroupAndStartScheduler ────────────────────────────────────────────

  describe('findGroupAndStartScheduler', () => {
    let logSpy, errSpy;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    test('group found — cron started with correct schedule', async () => {
      await connectAndOpen();
      expect(mockSchedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function));
    });

    test('group found — checkAndSendBirthdays runs immediately', async () => {
      await connectAndOpen(FYLD_GROUP, []);
      expect(mockDb).toHaveBeenCalledWith('contacts');
    });

    test('group not found — logs available group names', async () => {
      await connectAndOpen({ id1: { id: 'id1', subject: 'OtherGroup' } });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"OtherGroup"'));
    });

    test('group not found — logs (none) when no groups exist', async () => {
      await connectAndOpen({});
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('(none)'));
    });

    test('group not found — cron NOT started', async () => {
      await connectAndOpen({ id1: { id: 'id1', subject: 'OtherGroup' } });
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    test('second open event stops previous cron before starting new one', async () => {
      await connectAndOpen(FYLD_GROUP, []);
      // Fire open again (reconnect scenario)
      mockOrderBy.mockResolvedValue([]);
      await mockSock._fire('connection.update', { connection: 'open' });
      await Promise.resolve();
      expect(mockCronJob.stop).toHaveBeenCalled();
    });

    test('groupFetchAllParticipating throws — resolves without propagating', async () => {
      mockSock.groupFetchAllParticipating.mockRejectedValue(new Error('WA error'));
      await birthdayBot.initBirthdayBot();
      await expect(
        mockSock._fire('connection.update', { connection: 'open' })
      ).resolves.toBeUndefined();
    });

    test('groupFetchAllParticipating throws — logs error', async () => {
      mockSock.groupFetchAllParticipating.mockRejectedValue(new Error('WA error'));
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('connection.update', { connection: 'open' });
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error finding group or starting scheduler'),
        'WA error'
      );
    });
  });

  // ── connect / initBirthdayBot ─────────────────────────────────────────────

  describe('connect / initBirthdayBot', () => {
    let logSpy, errSpy;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    test('QR event — calls qrcode.generate with correct args', async () => {
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('connection.update', { qr: 'mock-qr-data' });
      expect(mockGenerate).toHaveBeenCalledWith('mock-qr-data', { small: true });
    });

    test('QR event — logs scan instruction', async () => {
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('connection.update', { qr: 'mock-qr-data' });
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Scan the QR/i));
    });

    test('open event — logs connected message', async () => {
      await connectAndOpen();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Birthday Bot connected to WhatsApp!'));
    });

    test('close with code 500 — reconnects (makeWASocket called twice)', async () => {
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      });
      await Promise.resolve();
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
    });

    test('close with code 401 (logout) — does NOT reconnect', async () => {
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      await Promise.resolve();
      expect(makeWASocketMock).toHaveBeenCalledTimes(1);
    });

    test('logout — logs "Logged out" message', async () => {
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Logged out/i));
    });

    test('creds.update event — calls saveCreds', async () => {
      await birthdayBot.initBirthdayBot();
      await mockSock._fire('creds.update');
      expect(mockSaveCreds).toHaveBeenCalled();
    });

    test('useMultiFileAuthState throws — initBirthdayBot resolves without throwing', async () => {
      jest.resetModules();
      jest.doMock('@whiskeysockets/baileys', () => ({
        default: makeWASocketMock,
        useMultiFileAuthState: jest.fn().mockRejectedValue(new Error('auth fail')),
        DisconnectReason: { loggedOut: 401 },
      }));
      jest.doMock('qrcode-terminal', () => ({ generate: mockGenerate }));
      jest.doMock('node-cron',       () => ({ schedule: mockSchedule }));
      jest.doMock('pino',            () => jest.fn(() => ({})));
      jest.doMock('../src/models/database', () => mockDb);
      const bot = require('../src/services/birthdayBot');
      await expect(bot.initBirthdayBot()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to initialise Birthday Bot'),
        'auth fail'
      );
    });
  });
});
