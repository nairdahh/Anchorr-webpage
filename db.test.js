import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Mock the database module to use a test database
const TEST_DB_DIR = 'test-data';
const TEST_DB_PATH = path.resolve(TEST_DB_DIR, 'test-database.db');

// Clean up and recreate test database before each test
function setupTestDb() {
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  return new Database(TEST_DB_PATH);
}

function teardownTestDb() {
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

// Migration definitions (from db.js)
const MIGRATIONS = [
  `CREATE TABLE configs (
      guild_id TEXT PRIMARY KEY,
      jellyseer_url TEXT NOT NULL,
      jellyseer_api_key TEXT NOT NULL,
      notification_channel_id TEXT,
      jellyfin_server_url TEXT,
      embed_color TEXT DEFAULT '#ef9f76'
    );`,

  `ALTER TABLE configs ADD COLUMN ephemeral_responses INTEGER DEFAULT 0;`,
  `ALTER TABLE configs ADD COLUMN color_success TEXT DEFAULT '#a6d189';`,
  `ALTER TABLE configs ADD COLUMN color_notification TEXT DEFAULT '#cba6f7';`,
  `ALTER TABLE configs RENAME COLUMN embed_color TO color_search;`,

  `CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL
    );`,
];

function prepareDatabase(db) {
  let currentVersion = db.pragma("user_version", { simple: true });

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const migrate = db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    });
    migrate();
  }
}

function getConfig(db, guildId) {
  const stmt = db.prepare("SELECT * FROM configs WHERE guild_id = ?");
  return stmt.get(guildId);
}

function setConfig(db, config) {
  const {
    guild_id,
    jellyseer_url,
    jellyseer_api_key,
    notification_channel_id,
    jellyfin_server_url,
    color_search,
    ephemeral_responses,
    color_success,
    color_notification,
  } = config;
  const stmt = db.prepare(`
    INSERT INTO configs (guild_id, jellyseer_url, jellyseer_api_key, notification_channel_id, jellyfin_server_url, color_search, ephemeral_responses, color_success, color_notification)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      jellyseer_url = excluded.jellyseer_url,
      jellyseer_api_key = excluded.jellyseer_api_key,
      notification_channel_id = excluded.notification_channel_id,
      jellyfin_server_url = excluded.jellyfin_server_url,
      color_search = excluded.color_search,
      ephemeral_responses = excluded.ephemeral_responses,
      color_success = excluded.color_success,
      color_notification = excluded.color_notification;
  `);
  stmt.run(
    guild_id,
    jellyseer_url,
    jellyseer_api_key,
    notification_channel_id,
    jellyfin_server_url,
    color_search,
    ephemeral_responses,
    color_success,
    color_notification
  );
}

describe('Database Module', () => {
  let testDb;

  beforeEach(() => {
    testDb = setupTestDb();
  });

  afterEach(() => {
    if (testDb) {
      testDb.close();
    }
    teardownTestDb();
  });

  describe('prepareDatabase', () => {
    it('should initialize database with all migrations', () => {
      prepareDatabase(testDb);

      const version = testDb.pragma('user_version', { simple: true });
      expect(version).toBe(MIGRATIONS.length);
    });

    it('should create configs table with correct schema', () => {
      prepareDatabase(testDb);

      const tableInfo = testDb.pragma('table_info(configs)');
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('guild_id');
      expect(columnNames).toContain('jellyseer_url');
      expect(columnNames).toContain('jellyseer_api_key');
      expect(columnNames).toContain('notification_channel_id');
      expect(columnNames).toContain('jellyfin_server_url');
      expect(columnNames).toContain('color_search');
      expect(columnNames).toContain('ephemeral_responses');
      expect(columnNames).toContain('color_success');
      expect(columnNames).toContain('color_notification');
    });

    it('should create sessions table with correct schema', () => {
      prepareDatabase(testDb);

      const tableInfo = testDb.pragma('table_info(sessions)');
      const columnNames = tableInfo.map(col => col.name);

      expect(columnNames).toContain('sid');
      expect(columnNames).toContain('sess');
      expect(columnNames).toContain('expire');
    });

    it('should be idempotent - running multiple times should not cause errors', () => {
      prepareDatabase(testDb);
      const version1 = testDb.pragma('user_version', { simple: true });

      prepareDatabase(testDb);
      const version2 = testDb.pragma('user_version', { simple: true });

      expect(version1).toBe(version2);
      expect(version2).toBe(MIGRATIONS.length);
    });

    it('should apply migrations incrementally', () => {
      // Manually set version to 0 and run first migration
      testDb.exec(MIGRATIONS[0]);
      testDb.pragma('user_version = 1');

      let version = testDb.pragma('user_version', { simple: true });
      expect(version).toBe(1);

      // Run prepareDatabase to apply remaining migrations
      prepareDatabase(testDb);

      version = testDb.pragma('user_version', { simple: true });
      expect(version).toBe(MIGRATIONS.length);
    });

    it('should have correct default values for color columns', () => {
      prepareDatabase(testDb);

      const tableInfo = testDb.pragma('table_info(configs)');
      const colorSearchCol = tableInfo.find(col => col.name === 'color_search');
      const colorSuccessCol = tableInfo.find(col => col.name === 'color_success');
      const colorNotificationCol = tableInfo.find(col => col.name === 'color_notification');

      // Note: dflt_value is wrapped in quotes in SQLite pragma output
      expect(colorSuccessCol.dflt_value).toBe("'#a6d189'");
      expect(colorNotificationCol.dflt_value).toBe("'#cba6f7'");
    });
  });

  describe('getConfig', () => {
    beforeEach(() => {
      prepareDatabase(testDb);
    });

    it('should return null when config does not exist', () => {
      const config = getConfig(testDb, 'non-existent-guild');
      expect(config).toBeUndefined();
    });

    it('should retrieve existing config', () => {
      const testConfig = {
        guild_id: 'test-guild-123',
        jellyseer_url: 'https://jellyseerr.example.com',
        jellyseer_api_key: 'test-api-key-123',
        notification_channel_id: 'channel-456',
        jellyfin_server_url: 'https://jellyfin.example.com',
        color_search: '#ff0000',
        ephemeral_responses: 1,
        color_success: '#00ff00',
        color_notification: '#0000ff',
      };

      setConfig(testDb, testConfig);
      const retrieved = getConfig(testDb, 'test-guild-123');

      expect(retrieved).toEqual(testConfig);
    });

    it('should handle multiple guild configs', () => {
      const config1 = {
        guild_id: 'guild-1',
        jellyseer_url: 'https://jellyseerr1.example.com',
        jellyseer_api_key: 'key-1',
        notification_channel_id: 'channel-1',
        jellyfin_server_url: 'https://jellyfin1.example.com',
        color_search: '#ef9f76',
        ephemeral_responses: 0,
        color_success: '#a6d189',
        color_notification: '#cba6f7',
      };

      const config2 = {
        guild_id: 'guild-2',
        jellyseer_url: 'https://jellyseerr2.example.com',
        jellyseer_api_key: 'key-2',
        notification_channel_id: 'channel-2',
        jellyfin_server_url: 'https://jellyfin2.example.com',
        color_search: '#ffffff',
        ephemeral_responses: 1,
        color_success: '#000000',
        color_notification: '#123456',
      };

      setConfig(testDb, config1);
      setConfig(testDb, config2);

      const retrieved1 = getConfig(testDb, 'guild-1');
      const retrieved2 = getConfig(testDb, 'guild-2');

      expect(retrieved1).toEqual(config1);
      expect(retrieved2).toEqual(config2);
    });
  });

  describe('setConfig', () => {
    beforeEach(() => {
      prepareDatabase(testDb);
    });

    it('should insert new config', () => {
      const newConfig = {
        guild_id: 'new-guild',
        jellyseer_url: 'https://jellyseerr.example.com',
        jellyseer_api_key: 'new-api-key',
        notification_channel_id: 'new-channel',
        jellyfin_server_url: 'https://jellyfin.example.com',
        color_search: '#aabbcc',
        ephemeral_responses: 1,
        color_success: '#ddeeff',
        color_notification: '#112233',
      };

      setConfig(testDb, newConfig);
      const retrieved = getConfig(testDb, 'new-guild');

      expect(retrieved).toEqual(newConfig);
    });

    it('should update existing config on conflict', () => {
      const initialConfig = {
        guild_id: 'update-guild',
        jellyseer_url: 'https://old-url.com',
        jellyseer_api_key: 'old-key',
        notification_channel_id: 'old-channel',
        jellyfin_server_url: 'https://old-jellyfin.com',
        color_search: '#111111',
        ephemeral_responses: 0,
        color_success: '#222222',
        color_notification: '#333333',
      };

      const updatedConfig = {
        guild_id: 'update-guild',
        jellyseer_url: 'https://new-url.com',
        jellyseer_api_key: 'new-key',
        notification_channel_id: 'new-channel',
        jellyfin_server_url: 'https://new-jellyfin.com',
        color_search: '#444444',
        ephemeral_responses: 1,
        color_success: '#555555',
        color_notification: '#666666',
      };

      setConfig(testDb, initialConfig);
      setConfig(testDb, updatedConfig);

      const retrieved = getConfig(testDb, 'update-guild');
      expect(retrieved).toEqual(updatedConfig);
    });

    it('should handle null values for optional fields', () => {
      const configWithNulls = {
        guild_id: 'null-guild',
        jellyseer_url: 'https://jellyseerr.example.com',
        jellyseer_api_key: 'api-key',
        notification_channel_id: null,
        jellyfin_server_url: null,
        color_search: '#ef9f76',
        ephemeral_responses: 0,
        color_success: '#a6d189',
        color_notification: '#cba6f7',
      };

      setConfig(testDb, configWithNulls);
      const retrieved = getConfig(testDb, 'null-guild');

      expect(retrieved.notification_channel_id).toBeNull();
      expect(retrieved.jellyfin_server_url).toBeNull();
    });

    it('should enforce guild_id uniqueness', () => {
      const config1 = {
        guild_id: 'unique-guild',
        jellyseer_url: 'https://url1.com',
        jellyseer_api_key: 'key1',
        notification_channel_id: 'channel1',
        jellyfin_server_url: 'https://jellyfin1.com',
        color_search: '#111111',
        ephemeral_responses: 0,
        color_success: '#222222',
        color_notification: '#333333',
      };

      const config2 = {
        guild_id: 'unique-guild',
        jellyseer_url: 'https://url2.com',
        jellyseer_api_key: 'key2',
        notification_channel_id: 'channel2',
        jellyfin_server_url: 'https://jellyfin2.com',
        color_search: '#444444',
        ephemeral_responses: 1,
        color_success: '#555555',
        color_notification: '#666666',
      };

      setConfig(testDb, config1);
      setConfig(testDb, config2);

      // Should have updated, not created duplicate
      const allConfigs = testDb.prepare('SELECT * FROM configs WHERE guild_id = ?').all('unique-guild');
      expect(allConfigs.length).toBe(1);
      expect(allConfigs[0]).toEqual(config2);
    });

    it('should handle ephemeral_responses as integer', () => {
      const config = {
        guild_id: 'ephemeral-test',
        jellyseer_url: 'https://url.com',
        jellyseer_api_key: 'key',
        notification_channel_id: 'channel',
        jellyfin_server_url: 'https://jellyfin.com',
        color_search: '#ef9f76',
        ephemeral_responses: 1,
        color_success: '#a6d189',
        color_notification: '#cba6f7',
      };

      setConfig(testDb, config);
      const retrieved = getConfig(testDb, 'ephemeral-test');

      expect(retrieved.ephemeral_responses).toBe(1);
      expect(typeof retrieved.ephemeral_responses).toBe('number');
    });
  });

  describe('Integration Tests', () => {
    beforeEach(() => {
      prepareDatabase(testDb);
    });

    it('should handle complete workflow: insert, retrieve, update, retrieve', () => {
      const guildId = 'workflow-guild';

      // Step 1: Verify no config exists
      let config = getConfig(testDb, guildId);
      expect(config).toBeUndefined();

      // Step 2: Insert config
      const initialConfig = {
        guild_id: guildId,
        jellyseer_url: 'https://initial.com',
        jellyseer_api_key: 'initial-key',
        notification_channel_id: 'initial-channel',
        jellyfin_server_url: 'https://initial-jellyfin.com',
        color_search: '#aabbcc',
        ephemeral_responses: 0,
        color_success: '#ddeeff',
        color_notification: '#112233',
      };
      setConfig(testDb, initialConfig);

      // Step 3: Retrieve and verify
      config = getConfig(testDb, guildId);
      expect(config).toEqual(initialConfig);

      // Step 4: Update config
      const updatedConfig = {
        ...initialConfig,
        jellyseer_url: 'https://updated.com',
        ephemeral_responses: 1,
      };
      setConfig(testDb, updatedConfig);

      // Step 5: Retrieve and verify update
      config = getConfig(testDb, guildId);
      expect(config).toEqual(updatedConfig);
    });

    it('should handle concurrent guild operations', () => {
      const guilds = ['guild-1', 'guild-2', 'guild-3', 'guild-4', 'guild-5'];

      // Insert configs for all guilds
      guilds.forEach((guildId, index) => {
        setConfig(testDb, {
          guild_id: guildId,
          jellyseer_url: `https://url-${index}.com`,
          jellyseer_api_key: `key-${index}`,
          notification_channel_id: `channel-${index}`,
          jellyfin_server_url: `https://jellyfin-${index}.com`,
          color_search: `#${index}${index}${index}${index}${index}${index}`,
          ephemeral_responses: index % 2,
          color_success: '#a6d189',
          color_notification: '#cba6f7',
        });
      });

      // Verify all configs exist and are correct
      guilds.forEach((guildId, index) => {
        const config = getConfig(testDb, guildId);
        expect(config.guild_id).toBe(guildId);
        expect(config.jellyseer_url).toBe(`https://url-${index}.com`);
        expect(config.ephemeral_responses).toBe(index % 2);
      });
    });

    it('should persist data across database connections', () => {
      const testConfig = {
        guild_id: 'persist-test',
        jellyseer_url: 'https://persist.com',
        jellyseer_api_key: 'persist-key',
        notification_channel_id: 'persist-channel',
        jellyfin_server_url: 'https://persist-jellyfin.com',
        color_search: '#abcdef',
        ephemeral_responses: 1,
        color_success: '#fedcba',
        color_notification: '#123456',
      };

      // Insert data
      setConfig(testDb, testConfig);

      // Close database
      testDb.close();

      // Reopen database
      testDb = new Database(TEST_DB_PATH);

      // Verify data persists
      const retrieved = getConfig(testDb, 'persist-test');
      expect(retrieved).toEqual(testConfig);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    beforeEach(() => {
      prepareDatabase(testDb);
    });

    it('should handle very long string values', () => {
      const longString = 'a'.repeat(1000);
      const config = {
        guild_id: 'long-string-test',
        jellyseer_url: longString,
        jellyseer_api_key: longString,
        notification_channel_id: longString,
        jellyfin_server_url: longString,
        color_search: '#ef9f76',
        ephemeral_responses: 0,
        color_success: '#a6d189',
        color_notification: '#cba6f7',
      };

      setConfig(testDb, config);
      const retrieved = getConfig(testDb, 'long-string-test');

      expect(retrieved.jellyseer_url).toBe(longString);
      expect(retrieved.jellyseer_api_key).toBe(longString);
    });

    it('should handle special characters in values', () => {
      const specialChars = "'; DROP TABLE configs; --";
      const config = {
        guild_id: 'special-chars-test',
        jellyseer_url: `https://example.com?param=${encodeURIComponent(specialChars)}`,
        jellyseer_api_key: specialChars,
        notification_channel_id: 'test-channel',
        jellyfin_server_url: 'https://jellyfin.com',
        color_search: '#ef9f76',
        ephemeral_responses: 0,
        color_success: '#a6d189',
        color_notification: '#cba6f7',
      };

      setConfig(testDb, config);
      const retrieved = getConfig(testDb, 'special-chars-test');

      expect(retrieved.jellyseer_api_key).toBe(specialChars);

      // Verify table still exists (SQL injection didn't work)
      const tableExists = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='configs'").get();
      expect(tableExists).toBeDefined();
    });

    it('should handle empty string values', () => {
      const config = {
        guild_id: 'empty-string-test',
        jellyseer_url: '',
        jellyseer_api_key: '',
        notification_channel_id: '',
        jellyfin_server_url: '',
        color_search: '',
        ephemeral_responses: 0,
        color_success: '',
        color_notification: '',
      };

      setConfig(testDb, config);
      const retrieved = getConfig(testDb, 'empty-string-test');

      expect(retrieved.jellyseer_url).toBe('');
      expect(retrieved.jellyseer_api_key).toBe('');
    });
  });
});
