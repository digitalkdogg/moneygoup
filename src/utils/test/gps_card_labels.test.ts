import { getCardCallLabel, getCardBadgeClass, getGpsLabel } from '@/utils/gps'

describe('getCardCallLabel — variant B band scheme (cards only)', () => {
  it.each([
    [null, '—'],
    [0,    'Strong Sell'],
    [24.9, 'Strong Sell'],
    [25,   'Sell'],          // boundary: 25 = Sell, not Strong Sell
    [30,   'Sell'],
    [44.9, 'Sell'],
    [45,   'Hold'],          // boundary: 45 = Hold, not Sell
    [50,   'Hold'],
    [54.9, 'Hold'],
    [55,   'Buy'],           // boundary: 55 = Buy, not Hold
    [65,   'Buy'],
    [74.9, 'Buy'],
    [75,   'Strong Buy'],    // boundary: 75 = Strong Buy, not Buy
    [80,   'Strong Buy'],
    [100,  'Strong Buy'],
  ])('score %s → %s', (score, expected) => {
    expect(getCardCallLabel(score)).toBe(expected)
  })

  it('does NOT match canonical getGpsLabel at the inner band boundaries', () => {
    // Variant B's Buy threshold (55) is lower than canonical (65)
    expect(getCardCallLabel(60)).toBe('Buy')
    expect(getGpsLabel(60)).toBe('Hold')
    // Variant B's Strong Buy threshold (75) is lower than canonical (80)
    expect(getCardCallLabel(77)).toBe('Strong Buy')
    expect(getGpsLabel(77)).toBe('Buy')
    // Variant B's Strong Sell threshold (25) is lower than canonical (30)
    expect(getCardCallLabel(27)).toBe('Sell')
    expect(getGpsLabel(27)).toBe('Strong Sell')
  })
})

describe('getCardBadgeClass — color ramp aligned to variant B', () => {
  it('returns grey placeholder class for null', () => {
    expect(getCardBadgeClass(null)).toContain('gray')
  })

  it('uses green band classes at Strong Buy threshold (>=75)', () => {
    expect(getCardBadgeClass(75)).toMatch(/green-100/)
    expect(getCardBadgeClass(90)).toMatch(/green-100/)
  })

  it('uses emerald band classes for Buy (55-74)', () => {
    expect(getCardBadgeClass(55)).toMatch(/emerald/)
    expect(getCardBadgeClass(70)).toMatch(/emerald/)
  })

  it('uses yellow band classes for Hold (45-54)', () => {
    expect(getCardBadgeClass(45)).toMatch(/yellow/)
    expect(getCardBadgeClass(50)).toMatch(/yellow/)
  })

  it('uses orange band classes for Sell (25-44)', () => {
    expect(getCardBadgeClass(25)).toMatch(/orange/)
    expect(getCardBadgeClass(40)).toMatch(/orange/)
  })

  it('uses red band classes for Strong Sell (<25)', () => {
    expect(getCardBadgeClass(0)).toMatch(/red/)
    expect(getCardBadgeClass(24)).toMatch(/red/)
  })
})

describe('getGpsLabel — canonical thresholds unchanged', () => {
  // Lock the canonical band so future variant-B work can't silently shift it.
  it.each([
    [29, 'Strong Sell'],
    [30, 'Sell'],
    [44, 'Sell'],
    [45, 'Hold'],
    [64, 'Hold'],
    [65, 'Buy'],
    [79, 'Buy'],
    [80, 'Strong Buy'],
  ])('score %s → %s', (score, expected) => {
    expect(getGpsLabel(score)).toBe(expected)
  })
})
