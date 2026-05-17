import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import { validateConfig, sanitizeConfig } from './ConfigManager.js';
import type { TelegramConfig } from './types.js';

/** Helper to build a TelegramConfig with the given botToken and chatId. */
function makeConfig(botToken: string, chatId: string): TelegramConfig {
  return { botToken, chatId, timeoutMs: 600_000, maxRetries: 3, maxBackoffMs: 60_000 };
}

/** Arbitrary that produces strings that are empty or whitespace-only. */
const emptyOrWhitespace = fc.oneof(
  fc.constant(''),
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r')).filter((s) => s.trim().length === 0),
);

/** Arbitrary that produces realistic bot token strings (alphanumeric + colon, min length 9). */
const botTokenArb = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_-'), { minLength: 9 })
  .filter((s) => s.trim().length >= 9);

describe('ConfigManager property tests', () => {
  // Feature: kiro-telegram-integration, Property 1: Config validation rejects incomplete configurations
  // **Validates: Requirements 1.1, 1.2**
  describe('Property 1: Config validation rejects incomplete configurations', () => {
    test('rejects configs where botToken is missing/empty/whitespace', () => {
      fc.assert(
        fc.property(emptyOrWhitespace, fc.string(), (badToken, chatId) => {
          const result = validateConfig(makeConfig(badToken, chatId));
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    test('rejects configs where chatId is missing/empty/whitespace', () => {
      fc.assert(
        fc.property(fc.string(), emptyOrWhitespace, (botToken, badChatId) => {
          const result = validateConfig(makeConfig(botToken, badChatId));
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    test('rejects configs where both botToken and chatId are missing/empty/whitespace', () => {
      fc.assert(
        fc.property(emptyOrWhitespace, emptyOrWhitespace, (badToken, badChatId) => {
          const result = validateConfig(makeConfig(badToken, badChatId));
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThanOrEqual(2);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 2: Bot token is never exposed in serialized output
  // **Validates: Requirements 1.5**
  describe('Property 2: Bot token is never exposed in serialized output', () => {
    test('sanitized config JSON never contains the original botToken', () => {
      fc.assert(
        fc.property(botTokenArb, fc.string(), (botToken, chatId) => {
          const config = makeConfig(botToken, chatId);
          const sanitized = sanitizeConfig(config);
          const json = JSON.stringify(sanitized);
          expect(json).not.toContain(botToken);
        }),
        { numRuns: 100 },
      );
    });
  });
});
