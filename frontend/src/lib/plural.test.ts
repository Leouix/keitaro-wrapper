import { describe, expect, it } from 'vitest';
import { plural } from './plural';

describe('plural', () => {
  it('1 → one', () => {
    expect(plural(1, 'campaign', 'campaigns')).toBe('campaign');
  });

  it('0, 2–20, 21, 101 → many', () => {
    expect(plural(0, 'campaign', 'campaigns')).toBe('campaigns');
    expect(plural(2, 'campaign', 'campaigns')).toBe('campaigns');
    expect(plural(5, 'campaign', 'campaigns')).toBe('campaigns');
    expect(plural(11, 'campaign', 'campaigns')).toBe('campaigns');
    expect(plural(21, 'campaign', 'campaigns')).toBe('campaigns');
    expect(plural(101, 'campaign', 'campaigns')).toBe('campaigns');
  });

  it('offer forms do not break', () => {
    expect(plural(1, 'offer', 'offers')).toBe('offer');
    expect(plural(3, 'offer', 'offers')).toBe('offers');
  });

  it('negative and fractional numbers → many', () => {
    expect(plural(-1, 'campaign', 'campaigns')).toBe('campaigns');
    expect(plural(1.5, 'campaign', 'campaigns')).toBe('campaigns');
  });
});