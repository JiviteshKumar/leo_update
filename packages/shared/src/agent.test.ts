import { expect, test } from 'bun:test';
import { pageChanges } from './agent';

test('reports words that appeared and disappeared', () => {
  expect(pageChanges('Dates ‹ September 2026 › 1 2 3', 'Dates ‹ October 2026 › 1 2 3')).toBe(
    'added "October"; removed "September"',
  );
});

test('reports no change', () => {
  expect(pageChanges('a b c', 'a  b c')).toBe('no visible change');
});

test('counts repeated words', () => {
  expect(pageChanges('Team', 'Team Team')).toBe('added "Team"');
});

test('caps long lists', () => {
  const after = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
  expect(pageChanges('', after)).toContain('… (8 more)');
});
